import { f as ModelProviderDeclarationConfig } from "../../types.models-tqxsISRc.js";
import { Lt as ProviderCatalogContext } from "../../types-Vx7Jq4_-2.js";
//#region extensions/ollama/provider-discovery.d.ts
type OllamaProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  envVars: string[];
  auth: [];
  resolveSyntheticAuth: (ctx: {
    provider?: string;
    providerConfig?: ModelProviderDeclarationConfig;
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
  provider: ModelProviderDeclarationConfig;
} | null>;
declare const ollamaProviderDiscovery: OllamaProviderPlugin;
//#endregion
export { ollamaProviderDiscovery as default, ollamaProviderDiscovery };