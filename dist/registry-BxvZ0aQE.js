//#region extensions/slack/src/http/paths.ts
function normalizeSlackWebhookPath(path) {
	const trimmed = path?.trim();
	if (!trimmed) return "/slack/events";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
//#endregion
//#region extensions/slack/src/http/registry.ts
const SLACK_HTTP_ROUTES_GLOBAL_KEY = Symbol.for("openclaw.slack.httpRoutes.v1");
function getSlackHttpRoutes() {
	const globalStore = globalThis;
	const existing = globalStore[SLACK_HTTP_ROUTES_GLOBAL_KEY];
	if (existing instanceof Map) return existing;
	const routes = /* @__PURE__ */ new Map();
	globalStore[SLACK_HTTP_ROUTES_GLOBAL_KEY] = routes;
	return routes;
}
function registerSlackHttpHandler(params) {
	const normalizedPath = normalizeSlackWebhookPath(params.path);
	const routes = getSlackHttpRoutes();
	if (routes.has(normalizedPath)) {
		const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
		params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
		return () => {};
	}
	routes.set(normalizedPath, params.handler);
	return () => {
		getSlackHttpRoutes().delete(normalizedPath);
	};
}
async function handleSlackHttpRequest(req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const handler = getSlackHttpRoutes().get(url.pathname);
	if (!handler) return false;
	await handler(req, res);
	return true;
}
//#endregion
export { registerSlackHttpHandler as n, normalizeSlackWebhookPath as r, handleSlackHttpRequest as t };
