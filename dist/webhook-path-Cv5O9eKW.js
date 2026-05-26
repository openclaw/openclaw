//#region src/plugin-sdk/webhook-path.ts
/**
* @deprecated Compatibility subpath. Import webhook path helpers from
* `openclaw/plugin-sdk/webhook-ingress` instead.
*/
/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
function normalizeWebhookPath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "/";
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
	return withSlash;
}
/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
function resolveWebhookPath(params) {
	const trimmedPath = params.webhookPath?.trim();
	if (trimmedPath) return normalizeWebhookPath(trimmedPath);
	if (params.webhookUrl?.trim()) try {
		return normalizeWebhookPath(new URL(params.webhookUrl).pathname || "/");
	} catch {
		return null;
	}
	return params.defaultPath ?? null;
}
//#endregion
export { resolveWebhookPath as n, normalizeWebhookPath as t };
