import { t as createZalouserPluginBase } from "./shared-DWa4m1q9.js";
import { n as zalouserSetupAdapter } from "./setup-core-D1Su5ZAJ.js";
import { t as zalouserSetupWizard } from "./setup-surface-uiH502Wp.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
