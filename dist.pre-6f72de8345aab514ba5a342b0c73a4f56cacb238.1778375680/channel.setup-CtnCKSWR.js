import { t as createZalouserPluginBase } from "./shared-CkVRuqLS.js";
import { n as zalouserSetupAdapter } from "./setup-core-Ch-7bcHz.js";
import { t as zalouserSetupWizard } from "./setup-surface-BdDyu3nQ.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
