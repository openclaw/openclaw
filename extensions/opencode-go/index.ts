import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  resolveOAuthApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveFirstProviderCatalogAuth } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { OPENCODE_GO_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  listOpencodeGoModelCatalogEntries,
  normalizeOpencodeGoBaseUrl,
  normalizeOpencodeGoResolvedModel,
  resolveOpencodeGoModel,
  resolveOpencodeGoStarterModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { createOpencodeGoWireWrapper, createOpencodeGoWrapper } from "./stream.js";

const PROVIDER_ID = "opencode-go";
const loadConsoleOAuth = createLazyRuntimeModule(() => import("./console-oauth.js"));

async function signInWithOpencodeConsole(ctx: ProviderAuthContext) {
  const credentials = await (await loadConsoleOAuth()).loginOpencodeConsole(ctx);
  const notes = [
    "OpenClaw is signed in to the OpenCode Console workspace you picked for Go. Tokens refresh automatically.",
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
  // The starter model only becomes the default when this workspace's Go plan offers it.
  const defaultModel = await resolveOpencodeGoStarterModel({
    apiKey: credentials.access,
    preferredModelRef: OPENCODE_GO_DEFAULT_MODEL_REF,
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

function normalizeGoBaseUrl<T extends { api?: string | null; baseUrl?: string }>(value: T) {
  const baseUrl = normalizeOpencodeGoBaseUrl(value);
  return baseUrl && baseUrl !== value.baseUrl ? { ...value, baseUrl } : undefined;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  description: "Official OpenCode Go provider plugin",
  manifest,
  provider: {
    label: "OpenCode Go",
    docsPath: "/providers/models",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    manifestAuth: {
      hint: "Shared API key infrastructure for Zen + Go",
      promptMessage: "Enter OpenCode API key",
      profileIds: ["opencode:default", "opencode-go:default"],
      defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
      resolveDefaultModel: async ({ apiKey, signal }) =>
        await resolveOpencodeGoStarterModel({
          apiKey,
          preferredModelRef: OPENCODE_GO_DEFAULT_MODEL_REF,
          ...(signal ? { signal } : {}),
        }),
      expectedProviders: ["opencode", "opencode-go"],
      noteMessage: [
        "OpenCode Go is a separate paid subscription that uses the shared OpenCode API key.",
        "Go includes DeepSeek, Kimi, GLM, Qwen, MiniMax, and other coding models.",
        "Get your API key at: https://opencode.ai/auth",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    extraAuth: [
      {
        id: "oauth",
        label: "OpenCode Console browser sign-in (Go)",
        hint: "Sign in with your browser and pick a Console workspace with Go",
        kind: "device_code",
        wizard: {
          choiceId: "opencode-go-console",
          choiceLabel: "OpenCode Go (browser sign-in)",
          choiceHint: "Sign in in your browser and pick a Console workspace with Go",
          groupId: "opencode",
          groupLabel: "OpenCode Go",
          groupHint: "Browser sign-in or shared Zen + Go API key",
        },
        run: signInWithOpencodeConsole,
      },
    ],
    refreshOAuth: async (credential) =>
      (await loadConsoleOAuth()).refreshOpencodeConsoleCredential(credential),
    normalizeConfig: ({ providerConfig }) => normalizeGoBaseUrl(providerConfig),
    normalizeResolvedModel: ({ model }) => {
      const baseUrlNormalized = normalizeGoBaseUrl(model);
      return normalizeOpencodeGoResolvedModel(baseUrlNormalized ?? model) ?? baseUrlNormalized;
    },
    normalizeTransport: ({ api, baseUrl }) => normalizeGoBaseUrl({ api, baseUrl }),
    resolveDynamicModel: ({ modelId }) => resolveOpencodeGoModel(modelId),
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds !== undefined && !ctx.providerIds.includes(PROVIDER_ID)) {
          return null;
        }
        // A browser sign-in reaches catalogs only through resolveProviderAuth; API keys,
        // including the key shared with opencode, keep the existing lookup.
        const oauth = ctx.resolveProviderAuth(PROVIDER_ID, {
          oauthMarker: resolveOAuthApiKeyMarker(PROVIDER_ID),
        });
        const auth =
          oauth.mode === "oauth" && oauth.discoveryApiKey
            ? oauth
            : resolveFirstProviderCatalogAuth(ctx.resolveProviderApiKey, [PROVIDER_ID, "opencode"]);
        if (!auth) {
          return null;
        }
        if (!auth.discoveryApiKey) {
          return {
            provider: buildStaticOpencodeGoProviderConfig(auth.apiKey),
          };
        }
        return await runLiveProviderCatalog({
          providerId: PROVIDER_ID,
          profileId: auth.profileId,
          run: async () => ({
            provider: await buildOpencodeGoLiveProviderConfig({
              apiKey: auth.apiKey ?? auth.discoveryApiKey,
              discoveryApiKey: auth.discoveryApiKey,
            }),
          }),
        });
      },
    },
    augmentModelCatalog: () => listOpencodeGoModelCatalogEntries(),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    resolveThinkingProfile,
    classifyFailoverReason: ({ status, errorMessage }) =>
      status === 403 && /\bUpstream request failed:\s*Endpoint is unavailable\./i.test(errorMessage)
        ? "server_error"
        : undefined,
    resolveTransportTurnState: (ctx) => {
      if (!normalizeOpencodeGoBaseUrl({ api: ctx.model?.api, baseUrl: ctx.model?.baseUrl })) {
        return undefined;
      }
      if (
        Object.keys(ctx.model?.headers ?? {}).some(
          (name) => name.toLowerCase() === "x-opencode-session",
        )
      ) {
        return undefined;
      }
      const sessionId = ctx.sessionId?.trim() || ctx.turnId.trim();
      return sessionId ? { headers: { "x-opencode-session": sessionId } } : undefined;
    },
    wrapStreamFn: createOpencodeGoWrapper,
    wrapSimpleCompletionStreamFn: createOpencodeGoWireWrapper,
    isModernModelRef: () => true,
  },
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "opencode-go",
      capabilities: ["image"],
      defaultModels: {
        image: "kimi-k2.7-code",
      },
      describeImage: undefined,
      describeImages: undefined,
    });
  },
});
