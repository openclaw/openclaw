import { t as createZalouserPluginBase } from "./shared-DJVzAreZ.js";
import { n as zalouserSetupAdapter } from "./setup-core-6Kd8Qy6B.js";
import { t as zalouserSetupWizard } from "./setup-surface-BJz8zhbF.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
