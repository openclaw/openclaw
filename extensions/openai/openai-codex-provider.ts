import type {
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  listProfilesForProvider,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { loginOpenAICodexOAuth } from "openclaw/plugin-sdk/provider-auth-login";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  normalizeProviderId,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { fetchCodexUsage } from "openclaw/plugin-sdk/provider-usage";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";
import { resolveCodexAuthIdentity } from "./openai-codex-auth-identity.js";
import { buildOpenAICodexProvider } from "./openai-codex-catalog.js";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import {
  cloneFirstTemplateModel,
  findCatalogTemplate,
  isOpenAIApiBaseUrl,
  matchesExactOrPrefix,
} from "./shared.js";
import { wrapOpenAICodexProviderStream } from "./stream-hooks.js";
import {
  resolveOpenAITransportTurnState,
  resolveOpenAIWebSocketSessionPolicy,
} from "./transport-policy.js";

const PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_COST = {
  input: 2.5,
  output: 15,
  cacheRead: 0.25,
  cacheWrite: 0,
} as const;
const OPENAI_CODEX_GPT_54_MINI_COST = {
  input: 0.75,
  output: 4.5,
  cacheRead: 0.075,
  cacheWrite: 0,
} as const;
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;
const OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  "gpt-5.1-codex-mini",
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
] as const;
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128_000;
const OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS = 128_000;
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;
const OPENAI_CODEX_MODERN_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  "gpt-5.2",
  "gpt-5.2-codex",
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
] as const;

function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/chatgpt\.com\/backend-api\/?$/i.test(trimmed);
}

function normalizeCodexTransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useCodexTransport =
    !model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl) || isOpenAICodexBaseUrl(model.baseUrl);
  const api =
    useCodexTransport && model.api === "openai-responses" ? "openai-codex-responses" : model.api;
  const baseUrl =
    api === "openai-codex-responses" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl))
      ? OPENAI_CODEX_BASE_URL
      : model.baseUrl;
  if (api === model.api && baseUrl === model.baseUrl) {
    return model;
  }
  return {
    ...model,
    api,
    baseUrl,
  };
}

function resolveCodexForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = trimmedModelId.toLowerCase();

  let templateIds: readonly string[];
  let patch: Partial<ProviderRuntimeModel> | undefined;
  if (lower === OPENAI_CODEX_GPT_54_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_COST,
    };
  } else if (lower === OPENAI_CODEX_GPT_54_MINI_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID) {
    templateIds = [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS];
    patch = {
      api: "openai-codex-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_MODEL_ID) {
    templateIds = OPENAI_CODEX_TEMPLATE_MODEL_IDS;
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId: trimmedModelId,
      templateIds,
      ctx,
      patch,
    }) ??
    normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-codex-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      contextTokens: patch?.contextTokens,
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

async function refreshOpenAICodexOAuthCredential(cred: OAuthCredential) {
  try {
    const { refreshOpenAICodexToken } = await import("./openai-codex-provider.runtime.js");
    const refreshed = await refreshOpenAICodexToken(cred.refresh);
    return {
      ...cred,
      ...refreshed,
      type: "oauth" as const,
      provider: PROVIDER_ID,
      email: cred.email,
      displayName: cred.displayName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /extract\s+accountid\s+from\s+token/i.test(message) &&
      typeof cred.access === "string" &&
      cred.access.trim().length > 0
    ) {
      return cred;
    }
    throw error;
  }
}

async function runOpenAICodexOAuth(ctx: ProviderAuthContext) {
  let creds;
  try {
    creds = await loginOpenAICodexOAuth({
      prompter: ctx.prompter,
      runtime: ctx.runtime,
      isRemote: ctx.isRemote,
      openUrl: ctx.openUrl,
      localBrowserMessage: "Complete sign-in in browser…",
    });
  } catch {
    return { profiles: [] };
  }
  if (!creds) {
    return { profiles: [] };
  }

  const identity = resolveCodexAuthIdentity({
    accessToken: creds.access,
    email: typeof creds.email === "string" ? creds.email : undefined,
  });

  return buildOauthProviderAuthResult({
    providerId: PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: identity.email,
    profileName: identity.profileName,
  });
}

function buildOpenAICodexAuthDoctorHint(ctx: { profileId?: string }) {
  if (ctx.profileId !== CODEX_CLI_PROFILE_ID) {
    return undefined;
  }
  return "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.";
}

function buildSyntheticCatalogEntry(
  template: ReturnType<typeof findCatalogTemplate>,
  entry: {
    id: string;
    reasoning: boolean;
    input: readonly ("text" | "image")[];
    contextWindow: number;
    contextTokens?: number;
  },
) {
  if (!template) {
    return undefined;
  }
  return {
    ...template,
    id: entry.id,
    name: entry.id,
    reasoning: entry.reasoning,
    input: [...entry.input],
    contextWindow: entry.contextWindow,
    ...(entry.contextTokens === undefined ? {} : { contextTokens: entry.contextTokens }),
  };
}

export function buildOpenAICodexProviderPlugin(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    deprecatedProfileIds: [CODEX_CLI_PROFILE_ID],
    auth: [
      {
        id: "oauth",
        label: "ChatGPT OAuth",
        hint: "Browser sign-in",
        kind: "oauth",
        run: async (ctx) => await runOpenAICodexOAuth(ctx),
      },
    ],
    wizard: {
      setup: {
        choiceId: "openai-codex",
        choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
        choiceHint: "Browser sign-in",
        methodId: "oauth",
      },
    },
    catalog: {
      order: "profile",
      run: async (ctx) => {
        const authStore = ensureAuthProfileStore(ctx.agentDir, {
          allowKeychainPrompt: false,
        });
        if (listProfilesForProvider(authStore, PROVIDER_ID).length === 0) {
          return null;
        }
        return {
          provider: buildOpenAICodexProvider(),
        };
      },
    },
    resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
    buildAuthDoctorHint: (ctx) => buildOpenAICodexAuthDoctorHint(ctx),
    supportsXHighThinking: ({ modelId }) =>
      matchesExactOrPrefix(modelId, OPENAI_CODEX_XHIGH_MODEL_IDS),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
    buildReplayPolicy: (ctx) => buildOpenAIReplayPolicy(ctx),
    prepareExtraParams: (ctx) => {
      const transport = ctx.extraParams?.transport;
      if (transport === "auto" || transport === "sse" || transport === "websocket") {
        return ctx.extraParams;
      }
      return {
        ...ctx.extraParams,
        transport: "auto",
      };
    },
    wrapStreamFn: (ctx) => wrapOpenAICodexProviderStream(ctx),
    resolveTransportTurnState: (ctx) => resolveOpenAITransportTurnState(ctx),
    resolveWebSocketSessionPolicy: (ctx) => resolveOpenAIWebSocketSessionPolicy(ctx),
    resolveReasoningOutputMode: () => "native",
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      return normalizeCodexTransport(ctx.model);
    },
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) =>
      await fetchCodexUsage(ctx.token, ctx.accountId, ctx.timeoutMs, ctx.fetchFn),
    refreshOAuth: async (cred) => await refreshOpenAICodexOAuthCredential(cred),
    augmentModelCatalog: (ctx) => {
      const gpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
      });
      const gpt54MiniTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS,
      });
      const sparkTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS],
      });
      return [
        buildSyntheticCatalogEntry(gpt54Template, {
          id: OPENAI_CODEX_GPT_54_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
          contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
        }),
        buildSyntheticCatalogEntry(gpt54MiniTemplate, {
          id: OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS,
        }),
        buildSyntheticCatalogEntry(sparkTemplate, {
          id: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
          reasoning: true,
          input: ["text"],
          contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
        }),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
