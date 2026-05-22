import { t as createZalouserPluginBase } from "./shared-OwQD9VWk.js";
import { n as zalouserSetupAdapter } from "./setup-core-CbTHoKXk.js";
import { t as zalouserSetupWizard } from "./setup-surface-Dt8z-HUq.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
