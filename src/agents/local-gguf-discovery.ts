import type { OpenClawConfig } from "../config/config.js";
import type { DiscoveredModel, ModelDiscoverySource } from "./discovery-types.js";
import { resolveImplicitLocalGgufProvider } from "./local-gguf-provider.js";

export class LocalGgufDiscoverySource implements ModelDiscoverySource {
  async discover(context: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }): Promise<DiscoveredModel[]> {
    try {
      if (!context.config) {
        return [];
      }

      const provider = await resolveImplicitLocalGgufProvider({
        config: context.config,
        env: context.env,
      });

      if (!provider) {
        return [];
      }

      // File-based discovery: models are already resolved by the provider
      if (provider.models.length > 0) {
        return provider.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          provider: "local-gguf",
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
          input: m.input as DiscoveredModel["input"],
        }));
      }

      return [];
    } catch (err) {
      console.warn("[discovery] Failed to resolve local GGUF models:", err);
    }
    return [];
  }
}
