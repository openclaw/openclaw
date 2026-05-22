import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-CNZyOwmW.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-Dq_skF6S.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
