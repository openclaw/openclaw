import { t as createZalouserPluginBase } from "./shared-C4b7BArP.js";
import { n as zalouserSetupAdapter } from "./setup-core-Ny28x19f.js";
import { t as zalouserSetupWizard } from "./setup-surface-CwXQzqQA.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
