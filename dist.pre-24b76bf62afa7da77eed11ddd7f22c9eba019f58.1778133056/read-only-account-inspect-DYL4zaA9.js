import { t as getBundledChannelAccountInspector } from "./bundled-CYDoOvq5.js";
import { n as getLoadedChannelPlugin } from "./registry-BkfWr-Uk.js";
//#region src/channels/read-only-account-inspect.ts
async function inspectReadOnlyChannelAccount(params) {
	const inspectAccount = getLoadedChannelPlugin(params.channelId)?.config.inspectAccount ?? getBundledChannelAccountInspector(params.channelId);
	if (!inspectAccount) return null;
	return await Promise.resolve(inspectAccount(params.cfg, params.accountId));
}
//#endregion
export { inspectReadOnlyChannelAccount as t };
