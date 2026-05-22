import { t as createZalouserPluginBase } from "./shared-TRgwQL1N.js";
import { n as zalouserSetupAdapter } from "./setup-core-Cm2TMqHz.js";
import { t as zalouserSetupWizard } from "./setup-surface-hkI13cpt.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
