import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
} from "openclaw/plugin-sdk/provider-http";
import {
  CLAWROUTER_IMAGE_CAPABILITIES,
  CLAWROUTER_IMAGE_TIMEOUT_MS,
  GOOGLE_IMAGE_CAPABILITIES,
  GOOGLE_IMAGE_MODELS,
  isClawRouterGoogleImageModel,
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
      req.signal?.throwIfAborted();
      const google = isClawRouterGoogleImageModel(req.model);
      // The first import is part of this operation's budget, before any credential or network work.
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? CLAWROUTER_IMAGE_TIMEOUT_MS,
        label: google ? "ClawRouter Google images" : "ClawRouter image generation",
      });
      const runtime = await loadRuntime();
      req.signal?.throwIfAborted();
      const remaining = createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: google
          ? CLAWROUTER_IMAGE_TIMEOUT_MS
          : (deadline.timeoutMs ?? CLAWROUTER_IMAGE_TIMEOUT_MS),
      });
      remaining();
      return google
        ? runtime.generateClawRouterGoogleImage(req, remaining)
        : runtime.generateClawRouterImage(req, remaining);
    },
  };
}
