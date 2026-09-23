// Memory Wiki plugin module implements gateway behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-host-core";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  MemoryWikiDashboardUnavailableError,
  setMemoryWikiDashboardState,
} from "./compiled-cache.js";
import {
  resolveMemoryWikiAgentConfig,
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { listMemoryWikiImportInsights } from "./import-insights.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  probeObsidianCli,
  runObsidianCommand,
  runObsidianDaily,
  runObsidianOpen,
  runObsidianSearch,
} from "./obsidian.js";
import { getMemoryWikiPage, searchMemoryWiki, WIKI_SEARCH_MODES } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { buildMemoryWikiDoctorReport, resolveMemoryWikiStatus } from "./status.js";
import { initializeMemoryWikiVault } from "./vault.js";
import { listMemoryWikiOverview } from "./wiki-overview.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const ADMIN_SCOPE = "operator.admin" as const;
const LOCAL_FILE_INGEST_SCOPE = ADMIN_SCOPE;
type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function readStringParam(params: Record<string, unknown>, key: string): string | undefined;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true },
): string;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean },
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (options?.required) {
    throw new Error(`${key} is required.`);
  }
  return undefined;
}

function readEnumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readStringParam(params, key);
  if (!value) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${key} must be one of: ${allowed.join(", ")}.`);
}

function respondError(respond: GatewayRespond, error: unknown) {
  if (error instanceof MemoryWikiDashboardUnavailableError) {
    const retryable = error.state === "rebuilding";
    respond(
      false,
      undefined,
      errorShape(
        error.state === "compile-required" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        error.message,
        {
          details: { state: error.state },
          ...(retryable ? { retryable: true, retryAfterMs: 500 } : {}),
        },
      ),
    );
    return;
  }
  const message = formatErrorMessage(error);
  respond(false, undefined, { code: "internal_error", message });
}

export function registerMemoryWikiGatewayMethods(params: {
  api: OpenClawPluginApi;
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  getAppConfig?: () => OpenClawConfig | undefined;
  resolveConfig?: (agentId?: string, appConfig?: OpenClawConfig) => ResolvedMemoryWikiConfig;
  resolveSourceSyncSignal?: () => AbortSignal | undefined;
}) {
  const { api, config: baseConfig } = params;
  const registerResultMethod = (
    method: string,
    scope: typeof READ_SCOPE | typeof WRITE_SCOPE | typeof ADMIN_SCOPE,
    handler: (requestParams: GatewayMethodContext["params"]) => Promise<unknown>,
  ) => {
    api.registerGatewayMethod(
      method,
      async ({ params: requestParams, respond }) => {
        try {
          respond(true, await handler(requestParams));
        } catch (error) {
          respondError(respond, error);
        }
      },
      { scope },
    );
  };

  const syncImportedSourcesInBackground = (
    config: ResolvedMemoryWikiConfig,
    appConfig?: OpenClawConfig,
  ) => {
    const signal = params.resolveSourceSyncSignal?.();
    if (params.resolveSourceSyncSignal && !signal) {
      return;
    }
    void syncMemoryWikiImportedSources({
      config,
      appConfig,
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      if (signal?.aborted) {
        return;
      }
      setMemoryWikiDashboardState(config, { state: "failed" });
      api.logger.warn(`memory-wiki: background source sync failed: ${formatErrorMessage(error)}`);
    });
  };

  const getAppConfig = () => {
    if (params.getAppConfig) {
      return params.getAppConfig();
    }
    if (typeof api.runtime.config?.current === "function") {
      return api.runtime.config.current() as OpenClawConfig;
    }
    return params.appConfig;
  };
  const resolveSourceSyncSignal = () => {
    const signal = params.resolveSourceSyncSignal?.();
    if (params.resolveSourceSyncSignal && !signal) {
      throw new Error("Memory Wiki service is not active.");
    }
    return signal;
  };
  const resolveRequestContext = (requestParams: Record<string, unknown>) => {
    const signal = resolveSourceSyncSignal();
    const appConfig = getAppConfig();
    const requestedAgentId = readStringParam(requestParams, "agentId");
    const config = params.resolveConfig
      ? params.resolveConfig(requestedAgentId, appConfig)
      : resolveMemoryWikiAgentConfig({
          config: baseConfig,
          appConfig,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        });
    const agentId =
      config.agentId ??
      requestedAgentId ??
      (appConfig ? resolveDefaultAgentId(appConfig) : undefined);
    return { agentId, appConfig, config, signal };
  };

  const assertOfficialObsidianCliSupported = (config: ResolvedMemoryWikiConfig) => {
    if (config.vault.scope === "agent") {
      throw new Error(
        "Official Obsidian CLI actions do not support memory-wiki vault.scope=agent.",
      );
    }
  };

  registerResultMethod("wiki.status", READ_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    return await resolveMemoryWikiStatus(config, { appConfig });
  });

  registerResultMethod("wiki.importRuns", READ_SCOPE, async (requestParams) => {
    const { config } = resolveRequestContext(requestParams);
    const limit = readPositiveIntegerParam(requestParams, "limit");
    return await listMemoryWikiImportRuns(config, limit !== undefined ? { limit } : {});
  });

  registerResultMethod("wiki.importInsights", READ_SCOPE, async (requestParams) => {
    const { appConfig, config } = resolveRequestContext(requestParams);
    syncImportedSourcesInBackground(config, appConfig);
    return await listMemoryWikiImportInsights(config);
  });

  // Renamed from wiki.palace without an alias by maintainer decision: the method was
  // undocumented, its only known consumer is the version-locked Control UI, and stale
  // callers get an explicit unknown-method error rather than a silent failure.
  registerResultMethod("wiki.overview", READ_SCOPE, async (requestParams) => {
    const { appConfig, config } = resolveRequestContext(requestParams);
    syncImportedSourcesInBackground(config, appConfig);
    return await listMemoryWikiOverview(config);
  });

  registerResultMethod("wiki.init", WRITE_SCOPE, async (requestParams) => {
    const { config, signal } = resolveRequestContext(requestParams);
    return await initializeMemoryWikiVault(config, signal ? { signal } : undefined);
  });

  registerResultMethod("wiki.doctor", READ_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    const status = await resolveMemoryWikiStatus(config, { appConfig });
    return buildMemoryWikiDoctorReport(status);
  });

  registerResultMethod("wiki.compile", WRITE_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    return await compileMemoryWikiVault(config, signal ? { signal } : undefined);
  });

  registerResultMethod("wiki.ingest", LOCAL_FILE_INGEST_SCOPE, async (requestParams) => {
    const { config, signal } = resolveRequestContext(requestParams);
    const inputPath = readStringParam(requestParams, "inputPath", { required: true });
    const title = readStringParam(requestParams, "title");
    return await ingestMemoryWikiSource({
      config,
      inputPath,
      ...(title ? { title } : {}),
      ...(signal ? { signal } : {}),
    });
  });

  registerResultMethod("wiki.lint", WRITE_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    return await lintMemoryWikiVault(config, signal ? { signal } : undefined);
  });

  registerResultMethod("wiki.bridge.import", WRITE_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    return await syncMemoryWikiImportedSources({
      config: { ...config, vaultMode: "bridge" },
      appConfig,
      ...(signal ? { signal } : {}),
    });
  });

  registerResultMethod("wiki.unsafeLocal.import", WRITE_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    if (config.vault.scope === "agent") {
      throw new Error("Unsafe-local import does not support memory-wiki vault.scope=agent.");
    }
    return await syncMemoryWikiImportedSources({
      config: { ...config, vaultMode: "unsafe-local" },
      appConfig,
      ...(signal ? { signal } : {}),
    });
  });

  registerResultMethod("wiki.search", READ_SCOPE, async (requestParams) => {
    const { agentId, appConfig, config, signal } = resolveRequestContext(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    const query = readStringParam(requestParams, "query", { required: true });
    const maxResults = readPositiveIntegerParam(requestParams, "maxResults");
    const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
    const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
    const mode = readEnumParam(requestParams, "mode", WIKI_SEARCH_MODES);
    return await searchMemoryWiki({
      config,
      appConfig,
      ...(agentId ? { agentId } : {}),
      query,
      maxResults,
      searchBackend,
      searchCorpus,
      mode,
    });
  });

  registerResultMethod("wiki.apply", WRITE_SCOPE, async (requestParams) => {
    const { appConfig, config, signal } = resolveRequestContext(requestParams);
    // Source sync can write imported pages and indexes, so validate first.
    const mutation = normalizeMemoryWikiMutationInput(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    return await applyMemoryWikiMutation({
      config,
      mutation,
      ...(signal ? { signal } : {}),
    });
  });

  registerResultMethod("wiki.get", READ_SCOPE, async (requestParams) => {
    const { agentId, appConfig, config, signal } = resolveRequestContext(requestParams);
    await syncMemoryWikiImportedSources({ config, appConfig, ...(signal ? { signal } : {}) });
    const lookup = readStringParam(requestParams, "lookup", { required: true });
    const fromLine = readPositiveIntegerParam(requestParams, "fromLine");
    const lineCount = readPositiveIntegerParam(requestParams, "lineCount");
    const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
    const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
    return await getMemoryWikiPage({
      config,
      appConfig,
      ...(agentId ? { agentId } : {}),
      lookup,
      fromLine,
      lineCount,
      searchBackend,
      searchCorpus,
    });
  });

  registerResultMethod("wiki.obsidian.status", READ_SCOPE, () => probeObsidianCli());

  registerResultMethod("wiki.obsidian.search", WRITE_SCOPE, async (requestParams) => {
    const { config } = resolveRequestContext(requestParams);
    assertOfficialObsidianCliSupported(config);
    const query = readStringParam(requestParams, "query", { required: true });
    return await runObsidianSearch({ config, query });
  });

  registerResultMethod("wiki.obsidian.open", WRITE_SCOPE, async (requestParams) => {
    const { config } = resolveRequestContext(requestParams);
    assertOfficialObsidianCliSupported(config);
    const vaultPath = readStringParam(requestParams, "path", { required: true });
    return await runObsidianOpen({ config, vaultPath });
  });

  registerResultMethod("wiki.obsidian.command", WRITE_SCOPE, async (requestParams) => {
    const { config } = resolveRequestContext(requestParams);
    assertOfficialObsidianCliSupported(config);
    const id = readStringParam(requestParams, "id", { required: true });
    return await runObsidianCommand({ config, id });
  });

  registerResultMethod("wiki.obsidian.daily", WRITE_SCOPE, async (requestParams) => {
    const { config } = resolveRequestContext(requestParams);
    assertOfficialObsidianCliSupported(config);
    return await runObsidianDaily({ config });
  });
}
