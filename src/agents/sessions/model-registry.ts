import { join } from "node:path";
import type { Model } from "../../llm/types.js";
import { getAgentDir } from "../config.js";
import type { AuthStorage } from "./auth-storage-core.js";
import {
  ModelRegistry as ModelRegistryCore,
  type ModelRegistryOptions,
} from "./model-registry-core.js";

export type { ProviderConfigInput } from "./provider-config.js";
export type { ResolvedRequestAuth } from "./model-registry-sources.js";

// Keep standalone defaults out of prepared catalog construction; instance methods
// and their OAuth/stream runtime attachments remain owned by the shared class.
export class ModelRegistry extends ModelRegistryCore {
  /** @deprecated Use createAsync or fromCapturedSources. Supported through 2026-12-31; removal ships in the first January 2027 stable release. */
  static override create(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): ModelRegistry {
    return ModelRegistryCore.create.call(ModelRegistry, authStorage, modelsJsonPath, options);
  }

  static override async createAsync(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): Promise<ModelRegistry> {
    return ModelRegistryCore.createAsync.call(ModelRegistry, authStorage, modelsJsonPath, options);
  }

  static override fromCapturedSources(
    ...args: Parameters<typeof ModelRegistryCore.fromCapturedSources>
  ): ModelRegistry {
    return ModelRegistryCore.fromCapturedSources.call(ModelRegistry, ...args);
  }

  static override inMemory(authStorage: AuthStorage): ModelRegistry {
    return ModelRegistryCore.inMemory.call(ModelRegistry, authStorage);
  }

  override fork(
    authStorage: AuthStorage,
    publishedModels?: ReadonlyMap<string, readonly Model[]>,
  ): ModelRegistry {
    return new ModelRegistry(authStorage, undefined, { sourceSnapshot: this }, publishedModels);
  }
}
