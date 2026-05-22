import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-B9dyh-CC.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-vUI1Ko9k.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
