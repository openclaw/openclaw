import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { COHERE_BASE_URL } from "./models.js";

export const COHERE_LIVE_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
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
      return modelId ? [{ ...record, id: modelId, active: record?.is_deprecated !== true }] : [];
    });
  },
};
