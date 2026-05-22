import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-RWXvSx94.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-EQp6_nIO.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
