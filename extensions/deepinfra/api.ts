// Deepinfra API module exposes the plugin public contract.
export { buildDeepInfraProvider } from "./provider-catalog.js";
export { applyDeepInfraConfig } from "./onboard.js";
export {
  DEEPINFRA_DEFAULT_MODEL_REF,
  buildStaticDeepInfraProvider,
} from "./provider-static-catalog.js";
export { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";
export { deepinfraMediaUnderstandingProvider } from "./media-understanding-provider.js";
export { deepinfraEmbeddingProviderAdapter } from "./embedding-adapter.js";
export { buildDeepInfraSpeechProvider } from "./speech-provider.js";
export { buildDeepInfraVideoGenerationProvider } from "./video-generation-provider.js";
