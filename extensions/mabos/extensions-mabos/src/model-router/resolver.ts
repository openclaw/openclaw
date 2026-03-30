import type { ModelRegistry } from "./registry.js";
import type { ModelRouterConfig, ResolvedModel } from "./types.js";

export class ModelResolver {
  private registry: ModelRegistry;
  private fallbackChain: string[];

  constructor(registry: ModelRegistry, config?: ModelRouterConfig) {
    this.registry = registry;
    this.fallbackChain = config?.fallbackChain ?? [];
  }

  /**
   * Resolve a model identifier to a full ResolvedModel.
   * Accepts "provider/model" or just "model".
   */
  resolve(requested: string): ResolvedModel {
    // Parse provider/model format
    let provider: string | undefined;
    let modelId: string;

    if (requested.includes("/")) {
      const parts = requested.split("/");
      provider = parts[0];
      modelId = parts.slice(1).join("/");
    } else {
      modelId = requested;
    }

    // Direct lookup
    const spec = this.registry.getSpec(modelId);
    if (spec) {
      // If provider was specified, verify it matches
      if (provider && spec.provider !== provider) {
        throw new Error(
          `Model "${modelId}" belongs to provider "${spec.provider}", not "${provider}"`,
        );
      }
      return {
        modelId: spec.id,
        provider: spec.provider,
        spec,
      };
    }

    // Fallback chain
    for (const fallbackId of this.fallbackChain) {
      const fallbackSpec = this.registry.getSpec(fallbackId);
      if (fallbackSpec) {
        return {
          modelId: fallbackSpec.id,
          provider: fallbackSpec.provider,
          spec: fallbackSpec,
        };
      }
    }

    throw new Error(`Unable to resolve model "${requested}" and no fallback available`);
  }
}
