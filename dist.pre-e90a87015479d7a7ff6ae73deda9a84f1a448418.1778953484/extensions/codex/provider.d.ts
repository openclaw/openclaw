import { l as ModelProviderConfig } from "../../types.models-DfLOOuHc.js";
import { nn as ProviderPlugin } from "../../types-CT4HF0Ri.js";
import { r as CodexAppServerStartOptions } from "../../client-Dr1S_EoN.js";
import { r as CodexAppServerModelListResult } from "../../models-BXoPfUgA.js";

//#region extensions/codex/provider.d.ts
type CodexModelLister = (options: {
  timeoutMs: number;
  limit?: number;
  cursor?: string;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
}) => Promise<CodexAppServerModelListResult>;
type BuildCodexProviderOptions = {
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
};
type BuildCatalogOptions = {
  env?: NodeJS.ProcessEnv;
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
  onDiscoveryFailure?: (error: unknown) => void;
};
declare function buildCodexProvider(options?: BuildCodexProviderOptions): ProviderPlugin;
declare function buildCodexProviderCatalog(options?: BuildCatalogOptions): Promise<{
  provider: ModelProviderConfig;
}>;
declare function isModernCodexModel(modelId: string): boolean;
//#endregion
export { buildCodexProvider, buildCodexProviderCatalog, isModernCodexModel };