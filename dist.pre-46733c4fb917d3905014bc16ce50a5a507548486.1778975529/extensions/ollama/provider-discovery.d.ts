import { l as ModelProviderConfig } from "../../types.models-DIMxudWn.js";
import { Nt as ProviderCatalogContext } from "../../types-Dggwf5Fv.js";
//#region extensions/ollama/provider-discovery.d.ts
type OllamaProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  envVars: string[];
  auth: [];
  resolveSyntheticAuth: (ctx: {
    provider?: string;
    providerConfig?: ModelProviderConfig;
  }) => {
    apiKey: string;
    source: string;
    mode: "api-key";
  } | undefined;
  catalog: {
    order: "late";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runOllamaDiscovery>;
  };
};
declare function runOllamaDiscovery(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
} | null>;
declare const ollamaProviderDiscovery: OllamaProviderPlugin;
//#endregion
export { ollamaProviderDiscovery as default, ollamaProviderDiscovery };