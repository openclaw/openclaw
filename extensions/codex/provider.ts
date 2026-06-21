/**
 * Codex provider plugin and live app-server model catalog discovery.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCodexSystemPromptContribution } from "./prompt-overlay.js";
import {
  buildCodexModelDefinition,
  buildCodexProviderConfig,
  CODEX_APP_SERVER_AUTH_MARKER,
  CODEX_BASE_URL,
  CODEX_PROVIDER_ID,
  FALLBACK_CODEX_MODELS,
} from "./provider-catalog.js";
import type { CodexAppServerStartOptions } from "./src/app-server/config.js";
import type {
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;
const LIVE_DISCOVERY_ENV = "OPENCLAW_CODEX_DISCOVERY_LIVE";
const MODEL_DISCOVERY_PAGE_LIMIT = 100;
const CODEX_APP_SERVER_SETUP_METHOD_ID = "app-server";
const CODEX_DEFAULT_MODEL_REF = `${CODEX_PROVIDER_ID}/${FALLBACK_CODEX_MODELS[0].id}`;
const codexCatalogLog = createSubsystemLogger("codex/catalog");

type CodexModelLister = (options: {
  timeoutMs: number;
  limit?: number;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
}) => Promise<CodexAppServerModelListResult>;

type CodexRateLimitReader = (options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<typeof requestCodexAppServerRateLimitsLazy>[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}) => Promise<unknown>;

type BuildCodexProviderOptions = {
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
  readRateLimits?: CodexRateLimitReader;
};

type BuildCatalogOptions = {
  env?: NodeJS.ProcessEnv;
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
  onDiscoveryFailure?: (error: unknown) => void;
};

/**
 * Builds the Codex provider plugin, including setup metadata, catalog discovery,
 * dynamic model resolution, and prompt/thinking hooks.
 */
export function buildCodexProvider(options: BuildCodexProviderOptions = {}): ProviderPlugin {
  return {
    id: CODEX_PROVIDER_ID,
    label: "Codex",
    docsPath: "/providers/models",
    auth: [
      {
        id: CODEX_APP_SERVER_SETUP_METHOD_ID,
        label: "Codex app-server",
        hint: "Use the Codex app-server runtime and managed model catalog.",
        kind: "custom",
        wizard: {
          choiceId: CODEX_PROVIDER_ID,
          choiceLabel: "Codex app-server",
          choiceHint: "Use the Codex app-server runtime and managed model catalog.",
          assistantPriority: -40,
          groupId: CODEX_PROVIDER_ID,
          groupLabel: "Codex",
          groupHint: "Codex app-server model provider",
          onboardingScopes: ["text-inference"],
        },
        run: async () => ({ profiles: [], defaultModel: CODEX_DEFAULT_MODEL_REF }),
      },
    ],
    catalog: {
      order: "late",
      run: async (ctx) => {
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, CODEX_PROVIDER_ID);
        const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);
        return await buildCodexProviderCatalog({
          env: ctx.env,
          pluginConfig,
          listModels: options.listModels,
        });
      },
    },
    staticCatalog: {
      order: "late",
      run: async () => ({
        provider: buildCodexProviderConfig(FALLBACK_CODEX_MODELS),
      }),
    },
    resolveDynamicModel: (ctx) => resolveCodexDynamicModel(ctx.modelId),
    resolveSyntheticAuth: () => ({
      apiKey: CODEX_APP_SERVER_AUTH_MARKER,
      source: "codex-app-server",
      mode: "token",
    }),
    fetchUsageSnapshot: async (ctx) => {
      if (ctx.token !== CODEX_APP_SERVER_AUTH_MARKER) {
        return null;
      }
      const runtimePluginConfig = resolvePluginConfigObject(ctx.config, CODEX_PROVIDER_ID);
      const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);
      const [{ resolveCodexAppServerRuntimeOptions }, { buildCodexAppServerUsageSnapshot }] =
        await Promise.all([
          import("./src/app-server/config.js"),
          import("./src/app-server/rate-limits.js"),
        ]);
      const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const rateLimits = await (options.readRateLimits ?? requestCodexAppServerRateLimitsLazy)({
        timeoutMs: ctx.timeoutMs,
        agentDir: ctx.agentDir,
        ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
        config: ctx.config,
        startOptions: appServer.start,
      });
      return buildCodexAppServerUsageSnapshot(rateLimits);
    },
    resolveThinkingProfile: ({ modelId }) => ({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        ...(isKnownXHighCodexModel(modelId) ? [{ id: "xhigh" as const }] : []),
      ],
    }),
    resolveSystemPromptContribution: ({ config, modelId }) =>
      resolveCodexSystemPromptContribution({ config, modelId }),
    isModernModelRef: ({ modelId }) => isModernCodexModel(modelId),
  };
}

/**
 * Builds the Codex model catalog from live app-server discovery, falling back
 * to built-in model records when discovery is disabled or unavailable.
 */
export async function buildCodexProviderCatalog(
  options: BuildCatalogOptions = {},
): Promise<{ provider: ModelProviderConfig }> {
  const { readCodexPluginConfig, resolveCodexAppServerRuntimeOptions } =
    await import("./src/app-server/config.js");
  const config = readCodexPluginConfig(options.pluginConfig);
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const timeoutMs = normalizeTimeoutMs(config.discovery?.timeoutMs);
  let discovered: CodexAppServerModel[] = [];
  if (config.discovery?.enabled !== false && !shouldSkipLiveDiscovery(options.env)) {
    discovered = await listModelsBestEffort({
      listModels: options.listModels ?? listAllCodexAppServerModelsLazy,
      timeoutMs,
      startOptions: appServer.start,
      onDiscoveryFailure: options.onDiscoveryFailure,
    });
  }
  return {
    provider: buildCodexProviderConfig(discovered.length > 0 ? discovered : FALLBACK_CODEX_MODELS),
  };
}

function resolveCodexDynamicModel(modelId: string) {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  const fallbackModel = FALLBACK_CODEX_MODELS.find((model) => model.id === id);
  return normalizeModelCompat({
    ...buildCodexModelDefinition({
      id,
      model: id,
      inputModalities: fallbackModel?.inputModalities ?? ["text"],
      supportedReasoningEfforts:
        fallbackModel?.supportedReasoningEfforts ??
        (shouldDefaultToReasoningModel(id) ? ["medium"] : []),
    }),
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
  } as ProviderRuntimeModel);
}

async function listModelsBestEffort(params: {
  listModels: CodexModelLister;
  timeoutMs: number;
  startOptions: CodexAppServerStartOptions;
  onDiscoveryFailure?: (error: unknown) => void;
}): Promise<CodexAppServerModel[]> {
  try {
    // The all-pages helper keeps one app-server client alive across pagination.
    const result = await params.listModels({
      timeoutMs: params.timeoutMs,
      limit: MODEL_DISCOVERY_PAGE_LIMIT,
      startOptions: params.startOptions,
      sharedClient: false,
    });
    return result.models.filter((model) => !model.hidden);
  } catch (error) {
    params.onDiscoveryFailure?.(error);
    codexCatalogLog.debug("codex model discovery failed; using fallback catalog", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function listAllCodexAppServerModelsLazy(options: {
  timeoutMs: number;
  limit?: number;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
}): Promise<CodexAppServerModelListResult> {
  const { listAllCodexAppServerModels } = await import("./src/app-server/models.js");
  return listAllCodexAppServerModels(options);
}

async function requestCodexAppServerRateLimitsLazy(options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<
    typeof import("./src/app-server/request.js").requestCodexAppServerJson
  >[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}): Promise<unknown> {
  const { requestCodexAppServerJson } = await import("./src/app-server/request.js");
  return await requestCodexAppServerJson({
    method: "account/rateLimits/read",
    timeoutMs: options.timeoutMs,
    agentDir: options.agentDir,
    ...(options.authProfileId ? { authProfileId: options.authProfileId } : {}),
    config: options.config,
    startOptions: options.startOptions,
    isolated: true,
  });
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function shouldSkipLiveDiscovery(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env[LIVE_DISCOVERY_ENV]?.trim().toLowerCase();
  if (override === "0" || override === "false") {
    return true;
  }
  return Boolean(env.VITEST) && override !== "1";
}

function shouldDefaultToReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  );
}

function isKnownXHighCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.includes("codex")
  );
}

/**
 * Returns true for Codex models that use the modern reasoning effort enum and
 * reject the legacy CLI `minimal` default.
 */
export function isModernCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower === "gpt-5.5" ||
    lower === "gpt-5.4" ||
    lower === "gpt-5.4-mini" ||
    lower === "gpt-5.3-codex-spark"
  );
}
