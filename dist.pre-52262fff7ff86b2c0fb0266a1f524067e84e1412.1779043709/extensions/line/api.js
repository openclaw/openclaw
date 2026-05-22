import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-CMl24DPJ.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-BWBld_vY.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
