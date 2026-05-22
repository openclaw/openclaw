import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { o as coerceSecretRef } from "./types.secrets-m6J7qPGz.js";
import { h as resolveNonEnvSecretRefApiKeyMarker } from "./model-auth-markers-DmHGyBd_.js";
import "./provider-auth-DoWWR1We.js";
import "./text-runtime-Dm9-PE_c.js";
import { a as resolveCloudflareAiGatewayBaseUrl, i as buildCloudflareAiGatewayModelDefinition } from "./models-aj5cw_r2.js";
//#region extensions/cloudflare-ai-gateway/catalog-provider.ts
function resolveCloudflareAiGatewayApiKey(cred) {
	if (!cred || cred.type !== "api_key") return;
	const keyRef = coerceSecretRef(cred.keyRef);
	const keyRefId = normalizeOptionalString(keyRef?.id);
	if (keyRef && keyRefId) return keyRef.source === "env" ? keyRefId : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
	return normalizeOptionalString(cred.key);
}
function resolveCloudflareAiGatewayMetadata(cred) {
	if (!cred || cred.type !== "api_key") return {};
	return {
		accountId: normalizeOptionalString(cred.metadata?.accountId),
		gatewayId: normalizeOptionalString(cred.metadata?.gatewayId)
	};
}
function buildCloudflareAiGatewayCatalogProvider(params) {
	const apiKey = normalizeOptionalString(params.envApiKey) ?? resolveCloudflareAiGatewayApiKey(params.credential);
	if (!apiKey) return null;
	const { accountId, gatewayId } = resolveCloudflareAiGatewayMetadata(params.credential);
	if (!accountId || !gatewayId) return null;
	const baseUrl = resolveCloudflareAiGatewayBaseUrl({
		accountId,
		gatewayId
	});
	if (!baseUrl) return null;
	return {
		baseUrl,
		api: "anthropic-messages",
		apiKey,
		models: [buildCloudflareAiGatewayModelDefinition()]
	};
}
//#endregion
export { buildCloudflareAiGatewayCatalogProvider as t };
