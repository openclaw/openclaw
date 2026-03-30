export {
	buildFoundryProviderBaseUrl,
	type CachedTokenEntry,
	extractFoundryEndpoint,
	isFoundryProviderApi,
	resolveConfiguredModelNameHint,
	TOKEN_REFRESH_MARGIN_MS,
} from "./shared.js";

export function getFoundryTokenCacheKey(params?: {
	subscriptionId?: string;
	tenantId?: string;
}): string {
	return `${params?.subscriptionId ?? ""}:${params?.tenantId ?? ""}`;
}
