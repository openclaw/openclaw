import { wt as ProviderAuthContext } from "../../types-Vx7Jq4_-2.js";
import { d as FoundrySelection, i as AzDeploymentSummary, l as FoundryProviderApi, n as AzAccount, u as FoundryResourceOption } from "../../shared-FgR3yAtS.js";
import { c as listSubscriptions } from "../../cli-CPHayYhI.js";

//#region extensions/microsoft-foundry/onboard.d.ts
declare function listResourceDeployments(resource: FoundryResourceOption, subscriptionId?: string): AzDeploymentSummary[];
declare function selectFoundryResource(ctx: ProviderAuthContext, selectedSub: AzAccount): Promise<FoundryResourceOption>;
declare function selectFoundryDeployment(ctx: ProviderAuthContext, resource: FoundryResourceOption, deployments: AzDeploymentSummary[]): Promise<AzDeploymentSummary>;
declare function promptEndpointAndModelManually(ctx: ProviderAuthContext): Promise<FoundrySelection>;
declare function promptApiKeyEndpointAndModel(ctx: ProviderAuthContext): Promise<FoundrySelection>;
declare function buildFoundryConnectionTest(params: {
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  api: FoundryProviderApi;
}): {
  url: string;
  body: Record<string, unknown>;
};
declare function isValidTenantIdentifier(value: string): boolean;
declare function promptTenantId(ctx: ProviderAuthContext, params?: {
  suggestions?: Array<{
    id: string;
    label?: string;
  }>;
  required?: boolean;
  reason?: string;
}): Promise<string | undefined>;
declare function loginWithTenantFallback(ctx: ProviderAuthContext): Promise<{
  account: AzAccount | null;
  tenantId?: string;
}>;
declare function testFoundryConnection(params: {
  ctx: ProviderAuthContext;
  endpoint: string;
  modelId: string;
  modelNameHint?: string;
  api: FoundryProviderApi;
  subscriptionId?: string;
  tenantId?: string;
}): Promise<void>;
//#endregion
export { buildFoundryConnectionTest, isValidTenantIdentifier, listResourceDeployments, listSubscriptions, loginWithTenantFallback, promptApiKeyEndpointAndModel, promptEndpointAndModelManually, promptTenantId, selectFoundryDeployment, selectFoundryResource, testFoundryConnection };