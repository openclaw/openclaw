//#region extensions/mattermost/src/gateway-auth-bypass.ts
const DEFAULT_SLASH_CALLBACK_PATH = "/api/channels/mattermost/command";
function readTrimmedString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeCallbackPath(value) {
	const trimmed = readTrimmedString(value);
	if (!trimmed) return DEFAULT_SLASH_CALLBACK_PATH;
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function readMattermostCommands(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isMattermostBypassPath(path) {
	return path === DEFAULT_SLASH_CALLBACK_PATH || path.startsWith("/api/channels/mattermost/");
}
function collectMattermostSlashCallbackPaths(raw) {
	const paths = new Set([normalizeCallbackPath(raw?.callbackPath)]);
	const callbackUrl = readTrimmedString(raw?.callbackUrl);
	if (callbackUrl) try {
		const pathname = new URL(callbackUrl).pathname;
		if (pathname) paths.add(pathname);
	} catch {}
	return [...paths];
}
function resolveMattermostGatewayAuthBypassPaths(cfg) {
	const base = cfg.channels?.mattermost && typeof cfg.channels.mattermost === "object" ? cfg.channels.mattermost : void 0;
	const callbackPaths = new Set(collectMattermostSlashCallbackPaths(readMattermostCommands(base?.commands)).filter(isMattermostBypassPath));
	const accounts = base?.accounts ?? {};
	for (const account of Object.values(accounts)) {
		const accountConfig = account && typeof account === "object" && !Array.isArray(account) ? account : void 0;
		for (const path of collectMattermostSlashCallbackPaths(readMattermostCommands(accountConfig?.commands))) if (isMattermostBypassPath(path)) callbackPaths.add(path);
	}
	return [...callbackPaths];
}
//#endregion
export { resolveMattermostGatewayAuthBypassPaths as t };
