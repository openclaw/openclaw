export type PersistedPluginModelCatalog = { pluginId: string; contents: string };

export type PluginModelCatalogReadResult = { error: string } | undefined;

export type PluginModelCatalogReadInput = {
  agentId: string;
  path: string;
  env: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
};
