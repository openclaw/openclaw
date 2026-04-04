import { Type } from "@sinclair/typebox";
import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import {
  composeProviderStreamWrappers,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream";
import {
  jsonResult,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  applyXaiModelCompat,
  normalizeXaiModelId,
  resolveXaiTransport,
  resolveXaiModelCompatPatch,
  shouldContributeXaiCompat,
} from "./api.js";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXaiProvider } from "./provider-catalog.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import {
  createXaiFastModeWrapper,
  createXaiToolCallArgumentDecodingWrapper,
  createXaiToolPayloadCompatibilityWrapper,
} from "./stream.js";
import { createXaiWebSearchProvider } from "./web-search.js";

const PROVIDER_ID = "xai";

function readConfiguredOrManagedApiKey(value: unknown): string | undefined {
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(value);
  return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : undefined;
}

function readLegacyGrokFallback(
  config: Record<string, unknown>,
): { apiKey: string; source: string } | undefined {
  const tools = config.tools;
  if (!tools || typeof tools !== "object") {
    return undefined;
  }
  const web = (tools as Record<string, unknown>).web;
  if (!web || typeof web !== "object") {
    return undefined;
  }
  const search = (web as Record<string, unknown>).search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  if (!grok || typeof grok !== "object") {
    return undefined;
  }
  const apiKey = readConfiguredOrManagedApiKey((grok as Record<string, unknown>).apiKey);
  return apiKey ? { apiKey, source: "tools.web.search.grok.apiKey" } : undefined;
}

function resolveXaiProviderFallbackAuth(
  config: unknown,
): { apiKey: string; source: string } | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const record = config as Record<string, unknown>;
  const pluginApiKey = readConfiguredOrManagedApiKey(
    resolveProviderWebSearchPluginConfig(record, PROVIDER_ID)?.apiKey,
  );
  if (pluginApiKey) {
    return {
      apiKey: pluginApiKey,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    };
  }
  return readLegacyGrokFallback(record);
}

function hasResolvableXaiApiKey(config: unknown): boolean {
  return Boolean(
    resolveXaiProviderFallbackAuth(config)?.apiKey || readProviderEnvValue(["XAI_API_KEY"]),
  );
}

function isCodeExecutionEnabled(config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return hasResolvableXaiApiKey(config);
  }
  const entries = (config as Record<string, unknown>).plugins;
  const pluginEntries =
    entries && typeof entries === "object"
      ? ((entries as Record<string, unknown>).entries as Record<string, unknown> | undefined)
      : undefined;
  const xaiEntry =
    pluginEntries && typeof pluginEntries.xai === "object"
      ? (pluginEntries.xai as Record<string, unknown>)
      : undefined;
  const pluginConfig =
    xaiEntry && typeof xaiEntry.config === "object"
      ? (xaiEntry.config as Record<string, unknown>)
      : undefined;
  const codeExecution =
    pluginConfig && typeof pluginConfig.codeExecution === "object"
      ? (pluginConfig.codeExecution as Record<string, unknown>)
      : undefined;
  if (codeExecution?.enabled === false) {
    return false;
  }
  return hasResolvableXaiApiKey(config);
}

function isXSearchEnabled(config: unknown): boolean {
  const resolved =
    config && typeof config === "object"
      ? resolveEffectiveXSearchConfig(config as never)
      : undefined;
  if (resolved?.enabled === false) {
    return false;
  }
  return hasResolvableXaiApiKey(config);
}

function createLazyCodeExecutionTool(ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
}) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  if (!isCodeExecutionEnabled(effectiveConfig)) {
    return null;
  }

  return {
    label: "Code Execution",
    name: "code_execution",
    description:
      "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task.",
      }),
    }),
    execute: async (toolCallId: string, args: Record<string, unknown>) => {
      const { createCodeExecutionTool } = await import("./code-execution.js");
      const tool = createCodeExecutionTool({
        config: ctx.config as never,
        runtimeConfig: (ctx.runtimeConfig as never) ?? null,
      });
      if (!tool) {
        return jsonResult({
          error: "missing_xai_api_key",
          message:
            "code_execution needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/code-execution",
        });
      }
      return await tool.execute(toolCallId, args);
    },
  };
}

function createLazyXSearchTool(ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
}) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  if (!isXSearchEnabled(effectiveConfig)) {
    return null;
  }

  return {
    label: "X Search",
    name: "x_search",
    description:
      "Search X (formerly Twitter) using xAI, including targeted post or thread lookups. For per-post stats like reposts, replies, bookmarks, or views, prefer the exact post URL or status ID.",
    parameters: Type.Object({
      query: Type.String({ description: "X search query string." }),
      allowed_x_handles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Only include posts from these X handles.",
        }),
      ),
      excluded_x_handles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Exclude posts from these X handles.",
        }),
      ),
      from_date: Type.Optional(
        Type.String({ description: "Only include posts on or after this date (YYYY-MM-DD)." }),
      ),
      to_date: Type.Optional(
        Type.String({ description: "Only include posts on or before this date (YYYY-MM-DD)." }),
      ),
      enable_image_understanding: Type.Optional(
        Type.Boolean({ description: "Allow xAI to inspect images attached to matching posts." }),
      ),
      enable_video_understanding: Type.Optional(
        Type.Boolean({ description: "Allow xAI to inspect videos attached to matching posts." }),
      ),
    }),
    execute: async (toolCallId: string, args: Record<string, unknown>) => {
      const { createXSearchTool } = await import("./x-search.js");
      const tool = createXSearchTool({
        config: ctx.config as never,
        runtimeConfig: (ctx.runtimeConfig as never) ?? null,
      });
      if (!tool) {
        return jsonResult({
          error: "missing_xai_api_key",
          message:
            "x_search needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      return await tool.execute(toolCallId, args);
    },
  };
}

export default defineSingleProviderPluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  provider: {
    label: "xAI",
    aliases: ["x-ai"],
    docsPath: "/providers/xai",
    auth: [
      {
        methodId: "api-key",
        label: "xAI API key",
        hint: "API key",
        optionKey: "xaiApiKey",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        promptMessage: "Enter xAI API key",
        defaultModel: XAI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXaiConfig(cfg),
        wizard: {
          groupLabel: "xAI (Grok)",
        },
      },
    ],
    catalog: {
      buildProvider: buildXaiProvider,
    },
    buildReplayPolicy: (ctx) => buildOpenAICompatibleReplayPolicy(ctx.modelApi),
    prepareExtraParams: (ctx) => {
      const extraParams = ctx.extraParams;
      if (extraParams && extraParams.tool_stream !== undefined) {
        return extraParams;
      }
      return {
        ...(extraParams ?? {}),
        tool_stream: true,
      };
    },
    wrapStreamFn: (ctx) => {
      const extraParams = ctx.extraParams;
      const fastMode = extraParams?.fastMode;
      const toolStreamEnabled = extraParams?.tool_stream !== false;
      return composeProviderStreamWrappers(ctx.streamFn, (streamFn) => {
        let wrappedStreamFn = createXaiToolPayloadCompatibilityWrapper(streamFn);
        if (typeof fastMode === "boolean") {
          wrappedStreamFn = createXaiFastModeWrapper(wrappedStreamFn, fastMode);
        }
        wrappedStreamFn = createXaiToolCallArgumentDecodingWrapper(wrappedStreamFn);
        return createToolStreamWrapper(wrappedStreamFn, toolStreamEnabled);
      });
    },
    // Provider-specific fallback auth stays owned by the xAI plugin so core
    // auth/discovery code can consume it generically without parsing xAI's
    // private config layout. Callers may receive a real key from the active
    // runtime snapshot or a non-secret SecretRef marker from source config.
    resolveSyntheticAuth: ({ config }) => {
      const fallbackAuth = resolveXaiProviderFallbackAuth(config);
      if (!fallbackAuth) {
        return undefined;
      }
      return {
        apiKey: fallbackAuth.apiKey,
        source: fallbackAuth.source,
        mode: "api-key" as const,
      };
    },
    normalizeResolvedModel: ({ model }) => applyXaiModelCompat(model),
    normalizeTransport: ({ provider, api, baseUrl }) =>
      resolveXaiTransport({ provider, api, baseUrl }),
    contributeResolvedModelCompat: ({ modelId, model }) =>
      shouldContributeXaiCompat({ modelId, model }) ? resolveXaiModelCompatPatch() : undefined,
    normalizeModelId: ({ modelId }) => normalizeXaiModelId(modelId),
    resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
  },
  register(api) {
    api.registerWebSearchProvider(createXaiWebSearchProvider());
    api.registerTool((ctx) => createLazyCodeExecutionTool(ctx), { name: "code_execution" });
    api.registerTool((ctx) => createLazyXSearchTool(ctx), { name: "x_search" });
  },
});
