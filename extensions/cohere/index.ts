import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildCohereCatalogModels, COHERE_BASE_URL, isModernCohereModelId } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const COHERE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "cohere")!;
const { applyConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: COHERE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "cohere",
    api: "openai-completions",
    baseUrl: COHERE_BASE_URL,
    catalogModels: buildCohereCatalogModels,
    aliases: [{ modelRef: COHERE_DEFAULT_MODEL_REF, alias: "Cohere Command A+" }],
  }),
});

function wrapCohereProviderStream(ctx: ProviderWrapStreamFnContext) {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
    // Cohere's Compatibility API uses developer, not system, for instructions.
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((message) => {
        const record = asOptionalObjectRecord(message);
        return record?.role === "system" ? { ...record, role: "developer" } : message;
      });
    }

    // Cohere lets tool-capable models choose a tool when tool_choice is omitted.
    delete payload.tool_choice;
  });
}

export default defineSingleProviderPluginEntry({
  id: "cohere",
  name: "Cohere Provider",
  description: "Cohere provider plugin",
  manifest,
  provider: {
    label: "Cohere",
    docsPath: "/providers/cohere",
    manifestAuth: { applyConfig },
    catalog: {
      discoveryMode: "strict",
      liveModelDiscovery: {
        endpointUrl: {
          url: "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000",
          requireBaseUrl: COHERE_BASE_URL,
        },
        readRows: (body) => {
          const models = asOptionalObjectRecord(body)?.models;
          if (!Array.isArray(models)) {
            throw new Error("Cohere model catalog response must contain models[]");
          }
          return models.flatMap((row) => {
            const record = asOptionalRecord(row);
            const modelId = normalizeOptionalString(record?.name);
            return modelId
              ? [{ ...record, id: modelId, active: record?.is_deprecated !== true }]
              : [];
          });
        },
      },
    },
    wrapStreamFn: wrapCohereProviderStream,
    wrapSimpleCompletionStreamFn: wrapCohereProviderStream,
    isModernModelRef: ({ modelId }) => isModernCohereModelId(modelId),
  },
});
