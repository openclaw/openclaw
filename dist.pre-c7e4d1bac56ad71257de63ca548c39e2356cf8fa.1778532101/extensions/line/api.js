import { n as lineChannelPluginCommon, t as linePlugin } from "./channel-Dg2MQ_pM.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "./setup-surface-BwPNJxwV.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
