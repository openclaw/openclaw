import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { GIGACHAT_PROVIDER_ID } from "./config.js";
import { applyGigachatConfig, GIGACHAT_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildGigachatProvider } from "./provider-catalog.js";
import { prepareGigachatRuntimeAuth } from "./runtime-auth.js";
import { wrapGigachatProviderStream } from "./stream.js";

export default defineSingleProviderPluginEntry({
  id: GIGACHAT_PROVIDER_ID,
  name: "GigaChat Provider",
  description: "Bundled GigaChat provider plugin",
  provider: {
    label: "GigaChat",
    docsPath: "/providers/gigachat",
    auth: [
      {
        methodId: "authorization-key",
        label: "GigaChat Authorization key",
        hint: "OAuth Authorization key from the Sber developer cabinet",
        optionKey: "gigachatAuthorizationKey",
        flagName: "--gigachat-authorization-key",
        envVar: "GIGACHAT_AUTHORIZATION_KEY",
        promptMessage: "Enter GigaChat Authorization key",
        defaultModel: GIGACHAT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyGigachatConfig(cfg),
        wizard: {
          choiceId: "gigachat-authorization-key",
          choiceLabel: "GigaChat Authorization key",
          choiceHint: "OAuth Authorization key from the Sber developer cabinet",
          groupId: GIGACHAT_PROVIDER_ID,
          groupLabel: "GigaChat",
          groupHint: "Sber OAuth Authorization key",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(GIGACHAT_PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...buildGigachatProvider(ctx.config),
            apiKey,
          },
        };
      },
      staticRun: async (ctx) => ({
        provider: buildGigachatProvider(ctx.config),
      }),
    },
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
    }),
    prepareRuntimeAuth: async (ctx) => await prepareGigachatRuntimeAuth(ctx),
    wrapStreamFn: (ctx) => wrapGigachatProviderStream(ctx.streamFn),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bgigachat\b.*(?:context|контекст|too large|payload too large|unprocessable entity|422|413)/i.test(
        errorMessage,
      ),
    classifyFailoverReason: ({ errorMessage }) =>
      /(?:429|too many requests|too many concurrent requests|слишком много запросов)/i.test(
        errorMessage,
      )
        ? "rate_limit"
        : undefined,
    isModernModelRef: () => true,
  },
});
