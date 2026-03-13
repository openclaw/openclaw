import type { ModelDefinitionConfig } from "../config/types.js";
export declare const KILOCODE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
/**
 * Discover models from the Kilo Gateway API with fallback to static catalog.
 * The /api/gateway/models endpoint is public and doesn't require authentication.
 */
export declare function discoverKilocodeModels(): Promise<ModelDefinitionConfig[]>;
