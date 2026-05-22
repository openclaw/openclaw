import { n as lineChannelPluginCommon, t as linePlugin } from "./channel-CQ0iOeIQ.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "./setup-surface-D9JcFz6T.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
