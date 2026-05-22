import { l as ModelProviderConfig } from "../../types.models-BWww8ZiS.js";
import { rn as ProviderPlugin } from "../../types-wNLvWYuA.js";
import { r as CodexAppServerStartOptions } from "../../client-Djp-87Bn.js";
import { r as CodexAppServerModelListResult } from "../../models-DwYDjAho.js";

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