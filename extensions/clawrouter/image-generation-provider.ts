import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  CLAWROUTER_IMAGE_CAPABILITIES,
  CLAWROUTER_IMAGE_TIMEOUT_MS,
  GOOGLE_IMAGE_CAPABILITIES,
  GOOGLE_IMAGE_MODELS,
} from "./image-model-catalog.js";

const loadRuntime = createLazyRuntimeModule(() => import("./image-generation-runtime.js"));

export function buildClawRouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    defaultTimeoutMs: CLAWROUTER_IMAGE_TIMEOUT_MS,
    // No credential-independent models/default: callers select an entitled live row.
    models: [],
    capabilities: CLAWROUTER_IMAGE_CAPABILITIES,
    capabilitiesByModel: Object.fromEntries(
      GOOGLE_IMAGE_MODELS.map((model) => [model, GOOGLE_IMAGE_CAPABILITIES]),
    ),
    async generateImage(req) {
      const { generateClawRouterImage } = await loadRuntime();
      return generateClawRouterImage(req);
    },
  };
}
