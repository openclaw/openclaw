import { n as lineChannelPluginCommon, t as linePlugin } from "../../channel-DQmAs5J_.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "../../setup-surface-WDy7bQrU.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
