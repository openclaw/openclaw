import { t as createZalouserPluginBase } from "./shared-BDzJOPvJ.js";
import { n as zalouserSetupAdapter } from "./setup-core-DjVGnxnn.js";
import { t as zalouserSetupWizard } from "./setup-surface-Dg2VurWx.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
