import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-B6QT0UsE.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-UXzmWS7I.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
