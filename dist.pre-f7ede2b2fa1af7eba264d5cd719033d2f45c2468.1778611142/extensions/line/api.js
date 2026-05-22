import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-De9cQVid.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-_CvZQy0F.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
