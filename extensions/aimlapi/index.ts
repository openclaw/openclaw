import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import { definePluginEntry } from "./api.js";
import { augmentAimlapiModelCatalog } from "./model-catalog.js";
import { AIMLAPI_DEFAULT_MODEL_REF, applyAimlapiConfig } from "./onboard.js";
import { buildAimlapiProvider } from "./provider-catalog.js";
import { createAimlapiWebSearchProvider } from "./src/aimlapi-web-search-provider.js";
import { buildAimlapiVideoGenerationProvider } from "./video-generation-provider.js";
import {
  normalizeAimlapiPayloadMessages,
  normalizeAimlapiPayloadTools,
  normalizeAimlapiToolChoice,
} from "./tool-payload.js";

const PROVIDER_ID = "aimlapi";

function createAimlapiPayloadWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return (model, context, options) => {
    const underlying = baseStreamFn;
    if (!underlying) {
      throw new Error(`AIMLAPI wrapper requires an underlying streamFn for ${String(model.id)}.`);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          payloadObj.tools = normalizeAimlapiPayloadTools(payloadObj.tools);
          payloadObj.tool_choice = normalizeAimlapiToolChoice(payloadObj.tool_choice);
          payloadObj.messages = normalizeAimlapiPayloadMessages(payloadObj.messages);
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "AIMLAPI Provider",
  description: "Bundled AIMLAPI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "AI/ML API",
      docsPath: "/providers/models",
      envVars: ["AIMLAPI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "AI/ML API key",
          hint: "API key",
          optionKey: "aimlapiApiKey",
          flagName: "--aimlapi-api-key",
          envVar: "AIMLAPI_API_KEY",
          promptMessage: "Enter AI/ML API key",
          defaultModel: AIMLAPI_DEFAULT_MODEL_REF,
          expectedProviders: ["aimlapi"],
          applyConfig: (cfg) => applyAimlapiConfig(cfg),
          noteMessage:
            "AI/ML API provides access to 300+ models through one API key.\nGet your API key from https://aimlapi.com",
          noteTitle: "AI/ML API",
          wizard: {
            choiceId: "aimlapi-api-key",
            choiceLabel: "AI/ML API key",
            groupId: "aimlapi",
            groupLabel: "AI/ML API",
            groupHint: "Supports 300+ models via a single API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildAimlapiProvider,
          }),
      },
      augmentModelCatalog: async (ctx) => await augmentAimlapiModelCatalog(ctx),
      isModernModelRef: () => true,
      wrapStreamFn: (ctx) => createAimlapiPayloadWrapper(ctx.streamFn),
    });
    api.registerWebSearchProvider(createAimlapiWebSearchProvider());
    api.registerVideoGenerationProvider(buildAimlapiVideoGenerationProvider());
  },
});
