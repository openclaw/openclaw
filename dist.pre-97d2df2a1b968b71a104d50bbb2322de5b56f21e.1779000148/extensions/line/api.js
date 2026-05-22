import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-b-iQlv2H.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-Bnfw_4BX.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
