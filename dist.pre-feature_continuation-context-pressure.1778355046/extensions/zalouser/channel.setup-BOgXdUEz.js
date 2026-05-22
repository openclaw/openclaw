import { t as createZalouserPluginBase } from "./shared-Cdmqwcrp.js";
import { n as zalouserSetupAdapter } from "./setup-core-BZoVpc8E.js";
import { t as zalouserSetupWizard } from "./setup-surface-BSpxO2Kk.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
