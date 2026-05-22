import { t as createZalouserPluginBase } from "./shared-D4A9Xs0e.js";
import { n as zalouserSetupAdapter } from "./setup-core-DSQ-JEQA.js";
import { t as zalouserSetupWizard } from "./setup-surface-2O3qPSqu.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
