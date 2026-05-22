import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-D8n01WLZ.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-C7a6rAmZ.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
