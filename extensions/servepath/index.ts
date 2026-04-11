import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildServepathDynamicModel,
  buildServepathProvider,
  SERVEPATH_DEFAULT_API_KEY_ENV_VAR,
  SERVEPATH_DEFAULT_MODEL_REF,
  SERVEPATH_PROVIDER_ID,
  SERVEPATH_PROVIDER_LABEL,
} from "./api.js";
import { applyServepathConfig } from "./onboard.js";

function resolveServepathDynamicModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel {
  return buildServepathDynamicModel(ctx.modelId);
}

export default definePluginEntry({
  id: SERVEPATH_PROVIDER_ID,
  name: "Servepath Provider",
  description: "Bundled Servepath provider plugin",
  register(api) {
    api.registerProvider({
      id: SERVEPATH_PROVIDER_ID,
      label: SERVEPATH_PROVIDER_LABEL,
      docsPath: "/providers/servepath",
      envVars: [SERVEPATH_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: SERVEPATH_PROVIDER_ID,
          methodId: "api-key",
          label: "Servepath API key",
          hint: "Use the short servepath alias or explicit routed refs",
          optionKey: "servepathApiKey",
          flagName: "--servepath-api-key",
          envVar: SERVEPATH_DEFAULT_API_KEY_ENV_VAR,
          promptMessage: "Enter Servepath API key",
          defaultModel: SERVEPATH_DEFAULT_MODEL_REF,
          expectedProviders: [SERVEPATH_PROVIDER_ID],
          applyConfig: (cfg) => applyServepathConfig(cfg),
          noteMessage: [
            "Servepath routes requests through one API key and one base URL.",
            "Use the short alias servepath for the default route in friendly UIs.",
            "OpenClaw stores the canonical routed ref as servepath/all.",
            "You can switch to explicit refs later, such as servepath/anthropic/claude-sonnet-4-6.",
          ].join("\n"),
          noteTitle: "Servepath",
          wizard: {
            choiceId: "servepath-api-key",
            choiceLabel: "Servepath API key",
            groupId: "servepath",
            groupLabel: "Servepath",
            groupHint: "Unified model gateway",
          },
        }),
      ],
      wizard: {
        modelPicker: {
          label: "Servepath",
          hint: "Short alias: servepath. Canonical routed ref: servepath/all",
          methodId: "api-key",
        },
      },
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(SERVEPATH_PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildServepathProvider(),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => resolveServepathDynamicModel(ctx),
      isModernModelRef: () => true,
      buildUnknownModelHint: () =>
        "Servepath requires authentication to be registered as a provider. " +
        'Set SERVEPATH_API_KEY or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/servepath",
    });
  },
});
