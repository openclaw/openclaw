// ClawRouter plugin entrypoint registers credential-scoped model routing.
import { definePluginEntry, type ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildGoogleGeminiReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildPassthroughGeminiSanitizingReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildClawRouterProviderConfig,
  normalizeClawRouterApiBaseUrl,
  normalizeClawRouterResolvedModel,
} from "./provider-catalog.js";
import { createClawRouterStreamFn, wrapClawRouterProviderStream } from "./stream.js";

const PROVIDER_ID = "clawrouter";
const ENV_VAR = "CLAWROUTER_API_KEY";

function buildApiKeyAuth(): ProviderAuthMethod {
  return createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: "api-key",
    label: "ClawRouter proxy key",
    hint: "Credential-scoped access to approved providers",
    optionKey: "clawrouterApiKey",
    flagName: "--clawrouter-api-key",
    envVar: ENV_VAR,
    promptMessage: "Enter ClawRouter proxy key",
    noteTitle: "ClawRouter",
    noteMessage: [
      "Use the proxy key issued by your ClawRouter administrator.",
      "OpenClaw discovers only the models granted to that key.",
    ].join("\n"),
    wizard: {
      choiceId: "clawrouter-api-key",
      choiceLabel: "ClawRouter proxy key",
      choiceHint: "Approved providers through one managed key",
      groupId: PROVIDER_ID,
      groupLabel: "ClawRouter",
      groupHint: "Managed provider access",
    },
  });
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "ClawRouter Provider",
  description: "Bundled ClawRouter provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ClawRouter",
      docsPath: "/providers/clawrouter",
      envVars: [ENV_VAR],
      auth: [buildApiKeyAuth()],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderAuth(PROVIDER_ID);
          let discoveryApiKey = auth.discoveryApiKey;
          if (!discoveryApiKey) {
            try {
              const { resolveApiKeyForProvider } =
                await import("openclaw/plugin-sdk/provider-auth-runtime");
              discoveryApiKey = (
                await resolveApiKeyForProvider({
                  provider: PROVIDER_ID,
                  cfg: ctx.config,
                  ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
                  ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
                  ...(auth.profileId ? { profileId: auth.profileId, lockedProfile: true } : {}),
                })
              )?.apiKey;
            } catch {
              return null;
            }
          }
          const apiKey = auth.apiKey ?? discoveryApiKey;
          if (!apiKey || !discoveryApiKey) {
            return null;
          }
          const configuredBaseUrl = ctx.config.models?.providers?.[PROVIDER_ID]?.baseUrl;
          try {
            return {
              provider: await buildClawRouterProviderConfig({
                apiKey,
                discoveryApiKey,
                baseUrl: configuredBaseUrl,
              }),
            };
          } catch {
            return null;
          }
        },
      },
      normalizeConfig: ({ providerConfig }) => {
        const baseUrl = normalizeClawRouterApiBaseUrl(providerConfig.baseUrl);
        return baseUrl !== providerConfig.baseUrl ? { ...providerConfig, baseUrl } : undefined;
      },
      createStreamFn: createClawRouterStreamFn,
      normalizeResolvedModel: ({ model }) => normalizeClawRouterResolvedModel(model),
      wrapSimpleCompletionStreamFn: wrapClawRouterProviderStream,
      wrapStreamFn: wrapClawRouterProviderStream,
      buildReplayPolicy: ({ modelApi, modelId }) => {
        if (modelApi === "anthropic-messages") {
          return buildNativeAnthropicReplayPolicyForModel(modelId);
        }
        if (modelApi === "google-generative-ai") {
          return buildGoogleGeminiReplayPolicy();
        }
        if (modelApi === "openai-completions" || modelApi === "openai-responses") {
          return buildPassthroughGeminiSanitizingReplayPolicy(modelId);
        }
        return undefined;
      },
      sanitizeReplayHistory: (ctx) =>
        ctx.modelApi === "google-generative-ai"
          ? sanitizeGoogleGeminiReplayHistory(ctx)
          : undefined,
      resolveReasoningOutputMode: (ctx) =>
        ctx.modelApi === "google-generative-ai" ? resolveTaggedReasoningOutputMode() : undefined,
      isModernModelRef: () => true,
    });
  },
});
