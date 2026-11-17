import { buildOpenAIProviderCatalog } from "./openai-provider-catalog.js";
import { createOpenAIProviderMetadata } from "./provider-metadata.js";

export default { ...createOpenAIProviderMetadata(), ...buildOpenAIProviderCatalog() };
