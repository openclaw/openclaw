import { t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import { n as listSlackAccountIds, r as mergeSlackAccountConfig } from "./accounts-OY4PvTjH.js";
import { r as normalizeSlackWebhookPath, t as handleSlackHttpRequest } from "./registry-CYDEhXu-.js";
//#region extensions/slack/src/http/plugin-routes.ts
function registerSlackPluginHttpRoutes(api) {
	const accountIds = new Set([DEFAULT_ACCOUNT_ID, ...listSlackAccountIds(api.config)]);
	const registeredPaths = /* @__PURE__ */ new Set();
	for (const accountId of accountIds) {
		const accountConfig = mergeSlackAccountConfig(api.config, accountId);
		registeredPaths.add(normalizeSlackWebhookPath(accountConfig.webhookPath));
	}
	if (registeredPaths.size === 0) registeredPaths.add(normalizeSlackWebhookPath());
	for (const path of registeredPaths) api.registerHttpRoute({
		path,
		auth: "plugin",
		handler: async (req, res) => await handleSlackHttpRequest(req, res)
	});
}
//#endregion
export { registerSlackPluginHttpRoutes as t };
