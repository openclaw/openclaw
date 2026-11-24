import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderStreamOptions } from "openclaw/plugin-sdk/llm";
import {
  describeImageWithModelPayloadTransform,
  describeImagesWithModelPayloadTransform,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  resolveOAuthApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveFirstProviderCatalogAuth } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyOpencodeZenProviderConfig, OPENCODE_ZEN_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeZenLiveProviderConfig,
  buildStaticOpencodeZenProviderConfig,
  listOpencodeZenModelCatalogEntries,
  normalizeOpencodeZenBaseUrl,
  prepareOpencodeZenModel,
  resolveOpencodeZenModel,
  resolveOpencodeZenStarterModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile as resolveOpencodeThinkingProfile } from "./provider-policy-api.js";
import { registerOpenCodeSessionCatalog } from "./session-catalog-plugin.js";
import { wrapOpencodeProviderStream } from "./stream.js";

const PROVIDER_ID = "opencode";
const loadConsoleOAuth = createLazyRuntimeModule(() => import("./console-oauth.js"));

async function signInWithOpencodeConsole(ctx: ProviderAuthContext) {
  const credentials = await (await loadConsoleOAuth()).loginOpencodeConsole(ctx);
  const notes = [
    "OpenClaw is signed in to the OpenCode Console workspace you picked. Tokens refresh automatically.",
  ];
  ctx.assertCurrent?.();
  const credentialOnly = {
    profiles: [
      {
        profileId: `${PROVIDER_ID}:default`,
        credential: { type: "oauth" as const, provider: PROVIDER_ID, ...credentials },
      },
    ],
    notes,
  };
  if (ctx.credentialOnly) {
    return credentialOnly;
  }
  // The starter model only becomes the default when this workspace offers it.
  const defaultModel = await resolveOpencodeZenStarterModel({
    apiKey: credentials.access,
    preferredModelRef: OPENCODE_ZEN_DEFAULT_MODEL_REF,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  ctx.assertCurrent?.();
  if (!defaultModel) {
    return credentialOnly;
  }
  return buildOauthProviderAuthResult({
    providerId: PROVIDER_ID,
    defaultModel,
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    profileName: "default",
    notes,
  });
}
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;

const stripDisabledResponsesReasoning: ProviderStreamOptions["onPayload"] = (payload) => {
  if (!isRecord(payload)) {
    return;
  }
  const reasoning = payload.reasoning;
  if (reasoning === "none" || (isRecord(reasoning) && reasoning.effort === "none")) {
    delete payload.reasoning;
  }
};

const opencodeMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "opencode",
  capabilities: ["image"],
  defaultModels: {
    image: "minimax-m3",
  },
  describeImage: (request) =>
    describeImageWithModelPayloadTransform(request, stripDisabledResponsesReasoning),
  describeImages: (request) =>
    describeImagesWithModelPayloadTransform(request, stripDisabledResponsesReasoning),
};

function isModernOpencodeModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}

function normalizeZenBaseUrl<T extends { api?: string | null; baseUrl?: string }>(value: T) {
  const baseUrl = normalizeOpencodeZenBaseUrl(value);
  return baseUrl && baseUrl !== value.baseUrl ? { ...value, baseUrl } : undefined;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Zen Provider",
  description: "OpenCode Zen provider plugin",
  manifest,
  provider: {
    label: "OpenCode Zen",
    docsPath: "/providers/models",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    manifestAuth: {
      hint: "Shared API key infrastructure for Zen + Go",
      promptMessage: "Enter OpenCode API key",
      profileIds: ["opencode:default", "opencode-go:default"],
      defaultModel: OPENCODE_ZEN_DEFAULT_MODEL_REF,
      resolveDefaultModel: async ({ apiKey, signal }) =>
        await resolveOpencodeZenStarterModel({
          apiKey,
          preferredModelRef: OPENCODE_ZEN_DEFAULT_MODEL_REF,
          ...(signal ? { signal } : {}),
        }),
      expectedProviders: ["opencode", "opencode-go"],
      applyConfig: applyOpencodeZenProviderConfig,
      noteMessage: [
        "One OpenCode API key can authenticate Zen and a separately subscribed Go catalog.",
        "Zen provides access to Claude, GPT, Gemini, and more models.",
        "Get your API key at: https://opencode.ai/auth",
        "Choose the Zen catalog when you want the curated multi-model proxy.",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    extraAuth: [
      {
        id: "oauth",
        label: "OpenCode Console browser sign-in",
        hint: "Sign in with your browser and pick a Console workspace",
        kind: "device_code",
        wizard: {
          choiceId: "opencode-console",
          choiceLabel: "OpenCode Console (browser sign-in)",
          choiceHint: "Sign in in your browser and pick an OpenCode Console workspace",
          groupId: "opencode",
          groupLabel: "OpenCode",
          groupHint: "Browser sign-in or shared Zen + Go API key",
        },
        run: signInWithOpencodeConsole,
      },
    ],
    refreshOAuth: async (credential) =>
      (await loadConsoleOAuth()).refreshOpencodeConsoleCredential(credential),
    normalizeConfig: ({ providerConfig }) => normalizeZenBaseUrl(providerConfig),
    normalizeResolvedModel: ({ model }) => normalizeZenBaseUrl(model),
    normalizeTransport: ({ api, baseUrl }) => normalizeZenBaseUrl({ api, baseUrl }),
    resolveDynamicModel: ({ modelId }) => resolveOpencodeZenModel(modelId),
    prepareDynamicModel: async (ctx) => {
      const profileProvider = ctx.authProfileId
        ? ctx.config?.auth?.profiles?.[ctx.authProfileId]?.provider
        : undefined;
      const ownsProfile = Boolean(
        ctx.authProfileId &&
        (ctx.authProfileId.startsWith("opencode:") ||
          ctx.authProfileId.startsWith("opencode-go:") ||
          profileProvider === "opencode" ||
          profileProvider === "opencode-go"),
      );
      const configured = Boolean(
        ownsProfile ||
        ctx.providerConfig ||
        ctx.config?.models?.providers?.opencode ||
        ctx.config?.models?.providers?.["opencode-go"] ||
        process.env.OPENCODE_API_KEY?.trim() ||
        process.env.OPENCODE_ZEN_API_KEY?.trim(),
      );
      return configured ? await prepareOpencodeZenModel({ modelId: ctx.modelId }) : undefined;
    },
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds !== undefined && !ctx.providerIds.includes(PROVIDER_ID)) {
          return null;
        }
        // A browser sign-in reaches catalogs only through resolveProviderAuth; API keys,
        // including the key shared with opencode-go, keep the existing lookup.
        const oauth = ctx.resolveProviderAuth(PROVIDER_ID, {
          oauthMarker: resolveOAuthApiKeyMarker(PROVIDER_ID),
        });
        const auth =
          oauth.mode === "oauth" && oauth.discoveryApiKey
            ? oauth
            : resolveFirstProviderCatalogAuth(ctx.resolveProviderApiKey, [
                PROVIDER_ID,
                "opencode-go",
              ]);
        if (!auth) {
          return null;
        }
        if (!auth.discoveryApiKey) {
          return {
            provider: buildStaticOpencodeZenProviderConfig(auth.apiKey),
          };
        }
        return await runLiveProviderCatalog({
          providerId: PROVIDER_ID,
          profileId: auth.profileId,
          run: async () => ({
            provider: await buildOpencodeZenLiveProviderConfig({
              apiKey: auth.apiKey ?? auth.discoveryApiKey,
              discoveryApiKey: auth.discoveryApiKey,
            }),
          }),
        });
      },
      staticRun: async () => ({ provider: buildStaticOpencodeZenProviderConfig() }),
    },
    augmentModelCatalog: () => listOpencodeZenModelCatalogEntries(),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
    resolveThinkingProfile: resolveOpencodeThinkingProfile,
    classifyFailoverReason: ({ status, errorType, code, errorMessage }) =>
      status === 403 &&
      (errorType === "FreeTierError" ||
        code === "FreeTierError" ||
        /\bFreeTierError\b|OpenCode's free tier can only be used from within OpenCode/.test(
          errorMessage,
        ))
        ? "model_not_found"
        : undefined,
    wrapStreamFn: wrapOpencodeProviderStream,
  },
  register(api) {
    api.registerMediaUnderstandingProvider(opencodeMediaUnderstandingProvider);
    registerOpenCodeSessionCatalog(api);
  },
});
