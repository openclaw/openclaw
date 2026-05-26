import { t as createZalouserPluginBase } from "./shared-CGta0CAl.js";
import { n as zalouserSetupAdapter } from "./setup-core-C3HYf_Ym.js";
import { t as zalouserSetupWizard } from "./setup-surface-CFdNRYlR.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
