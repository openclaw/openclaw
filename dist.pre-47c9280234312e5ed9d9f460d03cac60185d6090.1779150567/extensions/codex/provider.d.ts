import { l as ModelProviderConfig } from "../../types.models-DuD4I8NY.js";
import { sn as ProviderPlugin } from "../../types-B1YsHkjI.js";
import { r as CodexAppServerStartOptions } from "../../client-DkW8rB2P.js";
import { r as CodexAppServerModelListResult } from "../../models-B5zZ6-j9.js";

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