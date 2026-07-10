import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildGoogleAntigravityCliBackend,
  GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF,
  GOOGLE_ANTIGRAVITY_PROVIDER_ID,
} from "./backend.js";
import { probeAgy, type AgyProbeResult } from "./probe.js";

export const GOOGLE_ANTIGRAVITY_AUTH_MARKER = "antigravity-local-session";

const MODEL_DEFINITIONS = [
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash through Antigravity CLI",
    reasoning: false,
  },
  {
    id: "gemini-3-pro-low",
    name: "Gemini 3 Pro Low through Antigravity CLI",
    reasoning: true,
  },
  {
    id: "gemini-3-pro-high",
    name: "Gemini 3 Pro High through Antigravity CLI",
    reasoning: true,
  },
] as const;

function buildRuntimeModel(modelId: string): ProviderRuntimeModel | undefined {
  const definition = MODEL_DEFINITIONS.find((model) => model.id === modelId);
  if (!definition) {
    return undefined;
  }
  return {
    id: definition.id,
    name: definition.name,
    provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
    api: "google-generative-ai",
    baseUrl: "https://antigravity.invalid",
    reasoning: definition.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  };
}

function buildAntigravityConfigPatch() {
  return {
    agents: {
      defaults: {
        models: {
          [GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF]: {
            agentRuntime: { id: GOOGLE_ANTIGRAVITY_PROVIDER_ID },
          },
        },
      },
    },
  };
}

type BuildGoogleAntigravityProviderOptions = {
  probe?: () => AgyProbeResult;
};

export function buildGoogleAntigravityProvider(
  options: BuildGoogleAntigravityProviderOptions = {},
): ProviderPlugin {
  const runProbe = options.probe ?? probeAgy;
  return {
    id: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
    label: "Google Antigravity CLI (experimental)",
    docsPath: "/gateway/cli-backends",
    envVars: ["ANTIGRAVITY_USER_DATA_DIR"],
    auth: [
      {
        id: "custom",
        label: "Google Antigravity CLI (experimental)",
        hint: "Delegate text inference to a local signed-in agy CLI",
        kind: "custom",
        run: async (ctx: ProviderAuthContext) => {
          await ctx.prompter.note(
            [
              "Antigravity is preview software and this integration is experimental.",
              "OpenClaw delegates one-shot text inference to local agy --print.",
              "This is a distinct CLI provider and does not replace the hosted google-antigravity provider.",
              "This does not implement ACP, native OpenClaw tools, streaming events, persistent sessions, or cancellation.",
              "Antigravity owns Google authentication and session state.",
            ].join("\n"),
            "Google Antigravity CLI",
          );

          const proceed = await ctx.prompter.confirm({
            message: "Configure the local Antigravity agy runtime?",
            initialValue: false,
          });
          if (!proceed) {
            return { profiles: [] };
          }

          const result = runProbe();
          if (!result.ok) {
            throw new Error(result.reason);
          }

          return {
            profiles: [],
            defaultModel: GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF,
            configPatch: buildAntigravityConfigPatch(),
            notes: [
              "Uses the local signed-in agy runtime. OpenClaw does not import or persist Antigravity OAuth tokens.",
              "Prompts are passed through agy --print as command-line arguments and are limited to 8,000 characters.",
              "Because prompts are passed through argv, local process inspection may expose prompt text while agy is running.",
            ],
          };
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        choiceLabel: "Google Antigravity CLI (experimental)",
        choiceHint: "Delegate text inference to a local signed-in agy CLI",
        groupId: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        groupLabel: "Google Antigravity CLI",
        groupHint: "Experimental local CLI runtime",
        methodId: "custom",
      },
    },
    resolveSyntheticAuth: () => {
      const result = runProbe();
      if (!result.ok) {
        return null;
      }
      return {
        apiKey: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
        source: "local agy runtime",
        mode: "token",
      };
    },
    resolveDynamicModel: ({ modelId }) => buildRuntimeModel(modelId),
    augmentModelCatalog: () =>
      MODEL_DEFINITIONS.map((model) => ({
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: ["text"],
        contextWindow: 1_000_000,
      })),
    isModernModelRef: ({ modelId }) =>
      MODEL_DEFINITIONS.some((model) => model.id === modelId),
  };
}

export default definePluginEntry({
  id: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  name: "Google Antigravity CLI Provider",
  description: "Experimental delegated text inference through a local agy CLI",
  register(api: OpenClawPluginApi) {
    api.registerProvider(buildGoogleAntigravityProvider());
    api.registerCliBackend(buildGoogleAntigravityCliBackend());
  },
});
