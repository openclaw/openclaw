// Process-default registry/runtime retained for the OpenClaw compatibility
// facade (src/llm). Deliberately not part of the public package API: external
// consumers create isolated runtimes via createLlmRuntime(); exporting these
// from the root barrel would reintroduce the mutable process-global registry.
import { createApiRegistry } from "../api-registry.js";
import { createLlmRuntime } from "../stream.js";

export const defaultApiRegistry = createApiRegistry();
export const defaultLlmRuntime = createLlmRuntime(defaultApiRegistry);

export const {
  registerApiProvider,
  getApiProvider,
  getApiProviders,
  unregisterApiProviders,
  clearApiProviders,
} = defaultApiRegistry;

export const { stream, complete, streamSimple, completeSimple } = defaultLlmRuntime;
