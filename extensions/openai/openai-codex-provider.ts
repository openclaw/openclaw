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
  OPENAI_CODEX_DEFAULT_MODEL,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-models";
import { createOpenAIAttributionHeadersWrapper } from "openclaw/plugin-sdk/provider-stream";
import { fetchCodexUsage } from "openclaw/plugin-sdk/provider-usage";
import { buildOpenAICodexProvider } from "./openai-codex-catalog.js";
import {
  cloneFirstTemplateModel,
  findCatalogTemplate,
  isOpenAIApiBaseUrl,
  matchesExactOrPrefix,
} from "./shared.js";

const PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128_000;
const OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS = 128_000;
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;
const OPENAI_CODEX_MODERN_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  "gpt-5.2",
  "gpt-5.2-codex",
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
] as const;

type CodexJwtPayload = {
  iss?: unknown;
  sub?: unknown;
  "https://api.openai.com/profile"?: {
    email?: unknown;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_user_id?: unknown;
    chatgpt_user_id?: unknown;
    user_id?: unknown;
  };
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

function decodeCodexJwtPayload(accessToken: string): CodexJwtPayload | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as CodexJwtPayload) : null;
  } catch {
    return null;
  }
}

function resolveCodexStableSubject(payload: CodexJwtPayload | null): string | undefined {
  const auth = payload?.["https://api.openai.com/auth"];
  const accountUserId = normalizeNonEmptyString(auth?.chatgpt_account_user_id);
  if (accountUserId) {
    return accountUserId;
  }

  const userId =
    normalizeNonEmptyString(auth?.chatgpt_user_id) ?? normalizeNonEmptyString(auth?.user_id);
  if (userId) {
    return userId;
  }

  const iss = normalizeNonEmptyString(payload?.iss);
  const sub = normalizeNonEmptyString(payload?.sub);
  if (iss && sub) {
    return `${iss}|${sub}`;
  }
  return sub;
}

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
      contextWindow: OPENAI_CODEX_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
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
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

async function refreshOpenAICodexOAuthCredential(cred: OAuthCredential) {
  try {
    const { getOAuthApiKey } = await import("./openai-codex-provider.runtime.js");
    const refreshed = await getOAuthApiKey("openai-codex", {
      "openai-codex": cred,
    });
    if (!refreshed) {
      throw new Error("OpenAI Codex OAuth refresh returned no credentials.");
    }
    return {
      ...cred,
      ...refreshed.newCredentials,
      type: "oauth" as const,
      provider: PROVIDER_ID,
      email: cred.email,
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

  const payload = decodeCodexJwtPayload(creds.access);
  const resolvedEmail =
    normalizeNonEmptyString(payload?.["https://api.openai.com/profile"]?.email) ??
    normalizeNonEmptyString(creds.email);
  const stableSubject = resolveCodexStableSubject(payload);
  const resolvedEmailOrFallback =
    resolvedEmail ?? (stableSubject ? `id-${Buffer.from(stableSubject).toString("base64url")}` : undefined);

  return buildOauthProviderAuthResult({
    providerId: PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: resolvedEmailOrFallback,
  });
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
    capabilities: {
      providerFamily: "openai",
    },
    supportsXHighThinking: ({ modelId }) =>
      matchesExactOrPrefix(modelId, OPENAI_CODEX_XHIGH_MODEL_IDS),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
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
    wrapStreamFn: (ctx) => createOpenAIAttributionHeadersWrapper(ctx.streamFn),
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
      const sparkTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS],
      });
      return [
        gpt54Template
          ? {
              ...gpt54Template,
              id: OPENAI_CODEX_GPT_54_MODEL_ID,
              name: OPENAI_CODEX_GPT_54_MODEL_ID,
            }
          : undefined,
        sparkTemplate
          ? {
              ...sparkTemplate,
              id: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
              name: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
            }
          : undefined,
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
