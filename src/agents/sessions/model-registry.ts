import { join } from "node:path";
import { getAgentDir } from "../config.js";
import type { AuthStorage } from "./auth-storage.core.js";
import { ModelRegistry as CoreModelRegistry } from "./model-registry.core.js";

export type { ProviderConfigInput, ResolvedRequestAuth } from "./model-registry.core.js";
export type ModelRegistry = CoreModelRegistry;

type ModelRegistryOptions = NonNullable<Parameters<typeof CoreModelRegistry.create>[2]>;
const create = CoreModelRegistry.create;
const createAsync = CoreModelRegistry.createAsync;

// Keep public default resolution out of workers that already captured their sources.
export const ModelRegistry = Object.assign(CoreModelRegistry, {
  /** @deprecated Use createAsync or fromCapturedSources. Supported through 2026-12-31; removal ships in the first January 2027 stable release. */
  create(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): ModelRegistry {
    return create(authStorage, modelsJsonPath, options);
  },
  async createAsync(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): Promise<ModelRegistry> {
    return createAsync(authStorage, modelsJsonPath, options);
  },
});
