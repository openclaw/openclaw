import { t as createZalouserPluginBase } from "./shared-ShOFvA_M.js";
import { n as zalouserSetupAdapter } from "./setup-core-CWGfIURS.js";
import { t as zalouserSetupWizard } from "./setup-surface-DCN0XQ44.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
