import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/cloudflare-ai-gateway/onboard.d.ts
declare function buildCloudflareAiGatewayConfigPatch(params: {
  accountId: string;
  gatewayId: string;
}): {
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        baseUrl: string;
        api: "anthropic-messages";
        models: ModelDefinitionConfig[];
      };
    };
  };
  agents: {
    defaults: {
      models: {
        "cloudflare-ai-gateway/claude-sonnet-4-6": {
          alias: string;
        };
      };
    };
  };
};
declare function applyCloudflareAiGatewayProviderConfig(cfg: OpenClawConfig, params?: {
  accountId?: string;
  gatewayId?: string;
}): OpenClawConfig;
declare function applyCloudflareAiGatewayConfig(cfg: OpenClawConfig, params?: {
  accountId?: string;
  gatewayId?: string;
}): OpenClawConfig;
//#endregion
export { applyCloudflareAiGatewayProviderConfig as n, buildCloudflareAiGatewayConfigPatch as r, applyCloudflareAiGatewayConfig as t };