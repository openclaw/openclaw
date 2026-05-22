import { n as lineChannelPluginCommon, t as linePlugin } from "./channel-C6AjlOwh.js";
import { n as lineSetupAdapter, t as lineSetupWizard } from "./setup-surface-DM1Kkm72.js";
//#region extensions/line/src/channel.setup.ts
const lineSetupPlugin = {
	id: "line",
	...lineChannelPluginCommon,
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
};
//#endregion
export { linePlugin, lineSetupPlugin };
