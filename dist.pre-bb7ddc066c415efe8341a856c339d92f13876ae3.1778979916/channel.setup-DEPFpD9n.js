import { t as createZalouserPluginBase } from "./shared-eo7lmYSc.js";
import { n as zalouserSetupAdapter } from "./setup-core-BMO9NxwR.js";
import { t as zalouserSetupWizard } from "./setup-surface-C3B2iCdH.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
