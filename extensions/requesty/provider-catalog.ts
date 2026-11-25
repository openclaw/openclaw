import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { projectRequestyModels, REQUESTY_MODELS_PATH } from "./provider-models.js";

// `/v1/models/managed` lists the managed policies the caller's API key can route
// to, so discovery runs through the shared authenticated catalog path.
export const REQUESTY_LIVE_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
  endpointPath: REQUESTY_MODELS_PATH,
  projectRows: projectRequestyModels,
};
