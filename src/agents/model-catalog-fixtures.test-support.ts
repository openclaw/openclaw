import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { AgentHarness } from "./harness/types.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";

export const row = (
  provider: string,
  id: string,
  extra: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry => ({ provider, id, name: id, ...extra });
export const snapshot = (
  entries: ModelCatalogEntry[] = [],
  extra: Partial<ModelCatalogSnapshot> = {},
): ModelCatalogSnapshot => ({ entries, routeVariants: entries, ...extra });
export const authStore = (
  profiles: AuthProfileStore["profiles"] = {},
  extra: Partial<AuthProfileStore> = {},
): AuthProfileStore => ({ version: 1, profiles, ...extra });
export const apiKey = (provider: string, key = "synthetic-key") =>
  ({ type: "api_key", provider, key }) as const;
export const token = (value: string, expires?: number) =>
  ({
    type: "token",
    provider: "openai",
    token: value,
    ...(expires === undefined ? {} : { expires }),
  }) as const;
export const oauth = (provider: string, expires: number) =>
  ({
    type: "oauth",
    provider,
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires,
  }) as const;
export const model = (
  id: string,
  name = id,
  extra: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig => ({
  id,
  name,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 1024,
  ...extra,
});
export const providerConfig = (
  provider: string,
  declaration: ModelProviderConfig,
): OpenClawConfig => ({ models: { providers: { [provider]: declaration } } });
export const runtimeConfig = (runtimes: Record<string, string | undefined>): OpenClawConfig => ({
  agents: {
    defaults: {
      models: Object.fromEntries(
        Object.entries(runtimes).map(([id, runtime]) => [
          id,
          runtime ? { agentRuntime: { id: runtime } } : {},
        ]),
      ),
    },
  },
});
export function harnessRegistry(id: string, extra: Partial<AgentHarness> = {}) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: id,
    source: "fixture",
    harness: {
      id,
      label: id,
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("Catalog reads must not execute a model");
      },
      ...extra,
    },
  });
  return registry;
}
