import { l as ModelProviderConfig } from "../../types.models-DMZzPEHb.js";
import { Mt as ProviderCatalogContext } from "../../types-D40p5jC7.js";
//#region extensions/anthropic-vertex/provider-discovery.d.ts
type AnthropicVertexProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  auth: [];
  catalog: {
    order: "simple";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runAnthropicVertexCatalog>;
  };
  resolveConfigApiKey: (params: {
    env: NodeJS.ProcessEnv;
  }) => string | undefined;
  resolveSyntheticAuth: () => {
    apiKey: string;
    source: string;
    mode: "api-key";
  } | undefined;
};
declare function runAnthropicVertexCatalog(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
} | null>;
declare const anthropicVertexProviderDiscovery: AnthropicVertexProviderPlugin;
//#endregion
export { anthropicVertexProviderDiscovery, anthropicVertexProviderDiscovery as default };