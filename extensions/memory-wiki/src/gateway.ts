// Memory Wiki plugin module implements gateway behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-host-core";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { listMemoryWikiImportInsights } from "./import-insights.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { lintMemoryWikiVault } from "./lint.js";
import { listMemoryWikiPalace } from "./memory-palace.js";
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

class InvalidGatewayRequestError extends Error {}

function respondError(respond: GatewayRespond, error: unknown) {
  const message = formatErrorMessage(error);
  respond(false, undefined, {
    code: error instanceof InvalidGatewayRequestError ? "INVALID_REQUEST" : "internal_error",
    message,
  });
}

function resolveGatewayAgentId(
  requestParams: Record<string, unknown>,
  appConfig: OpenClawConfig | undefined,
): string | undefined {
  const requestedAgentId = readStringParam(requestParams, "agentId");
  if (!requestedAgentId) {
    return appConfig ? resolveDefaultAgentId(appConfig) : undefined;
  }
  if (!appConfig) {
    throw new InvalidGatewayRequestError("agentId requires an available agent registry.");
  }

  const agentId = normalizeAgentId(requestedAgentId);
  const knownAgentIds = new Set(listAgentIds(appConfig));
  if (knownAgentIds.has(agentId)) {
    return agentId;
  }

  const known = [...knownAgentIds].toSorted().join(", ");
  throw new InvalidGatewayRequestError(
    `Unknown agent id "${requestedAgentId}". Known agents: ${known || "none configured"}.`,
  );
}

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ config, appConfig });
}

export function registerMemoryWikiGatewayMethods(params: {
  api: OpenClawPluginApi;
  config: ResolvedMemoryWikiConfig;
  resolveConfig?: (agentId?: string, appConfig?: OpenClawConfig) => ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  resolveAppConfig?: () => OpenClawConfig | undefined;
}) {
  const { api, config: defaultConfig, appConfig: initialAppConfig } = params;
  const resolveConfig = params.resolveConfig ?? (() => defaultConfig);
  const resolveAppConfig = params.resolveAppConfig ?? (() => initialAppConfig);
  const resolveRequestContext = (requestParams: Record<string, unknown> = {}) => {
    const appConfig = resolveAppConfig();
    const agentId = resolveGatewayAgentId(requestParams, appConfig);
    const config = resolveConfig(agentId, appConfig);
    return {
      config,
      appConfig,
      agentId: config.agentId ?? (agentId ? normalizeAgentId(agentId) : undefined),
    };
  };

  api.registerGatewayMethod(
    "wiki.status",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(
          true,
          await resolveMemoryWikiStatus(config, {
            appConfig,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.importRuns",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const limit = readPositiveIntegerParam(requestParams, "limit");
        respond(true, await listMemoryWikiImportRuns(config, limit !== undefined ? { limit } : {}));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.importInsights",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await listMemoryWikiImportInsights(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.palace",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await listMemoryWikiPalace(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.init",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        respond(true, await initializeMemoryWikiVault(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.doctor",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const status = await resolveMemoryWikiStatus(config, {
          appConfig,
        });
        respond(true, buildMemoryWikiDoctorReport(status));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.compile",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await compileMemoryWikiVault(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.ingest",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const inputPath = readStringParam(requestParams, "inputPath", { required: true });
        const title = readStringParam(requestParams, "title");
        respond(
          true,
          await ingestMemoryWikiSource({
            config,
            inputPath,
            ...(title ? { title } : {}),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: LOCAL_FILE_INGEST_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.lint",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await lintMemoryWikiVault(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.bridge.import",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        respond(
          true,
          await syncMemoryWikiImportedSources({
            config: { ...config, vaultMode: "bridge" },
            appConfig,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.unsafeLocal.import",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        respond(
          true,
          await syncMemoryWikiImportedSources({
            config: { ...config, vaultMode: "unsafe-local" },
            appConfig,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.search",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig, agentId } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const query = readStringParam(requestParams, "query", { required: true });
        const maxResults = readPositiveIntegerParam(requestParams, "maxResults");
        const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
        const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
        const mode = readEnumParam(requestParams, "mode", WIKI_SEARCH_MODES);
        respond(
          true,
          await searchMemoryWiki({
            config,
            appConfig,
            ...(agentId ? { agentId } : {}),
            query,
            maxResults,
            searchBackend,
            searchCorpus,
            mode,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.apply",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(
          true,
          await applyMemoryWikiMutation({
            config,
            mutation: normalizeMemoryWikiMutationInput(requestParams),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.get",
    async ({ params: requestParams, respond }) => {
      try {
        const { config, appConfig, agentId } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const lookup = readStringParam(requestParams, "lookup", { required: true });
        const fromLine = readPositiveIntegerParam(requestParams, "fromLine");
        const lineCount = readPositiveIntegerParam(requestParams, "lineCount");
        const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
        const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
        respond(
          true,
          await getMemoryWikiPage({
            config,
            appConfig,
            ...(agentId ? { agentId } : {}),
            lookup,
            fromLine,
            lineCount,
            searchBackend,
            searchCorpus,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.status",
    async ({ respond }) => {
      try {
        respond(true, await probeObsidianCli());
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.search",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const query = readStringParam(requestParams, "query", { required: true });
        respond(true, await runObsidianSearch({ config, query }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.open",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const vaultPath = readStringParam(requestParams, "path", { required: true });
        respond(true, await runObsidianOpen({ config, vaultPath }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.command",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const id = readStringParam(requestParams, "id", { required: true });
        respond(true, await runObsidianCommand({ config, id }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.daily",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        respond(true, await runObsidianDaily({ config }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
