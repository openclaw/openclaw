import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";

export type PersistedPluginModelCatalog = { pluginId: string; contents: string };

export type PluginModelCatalogReadResult =
  | { error: string }
  | { legacyWarning: string | null }
  | undefined;

export type PluginModelCatalogReadTask = PluginModelCatalogReadInput | { legacyAgentDir: string };

export type PluginModelCatalogReadInput = {
  agentId: string;
  path: string;
  env: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  expectedIdentity?: DatabasePathIdentity;
};
