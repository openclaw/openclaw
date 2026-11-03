import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { OPPER_MODELS_PATH, projectOpperModels } from "./provider-models.js";

// `/models` lists what the caller's API key can route to under the organization's
// rules, so discovery runs through the shared authenticated catalog path.
export const OPPER_LIVE_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
  endpointPath: OPPER_MODELS_PATH,
  projectRows: projectOpperModels,
};
