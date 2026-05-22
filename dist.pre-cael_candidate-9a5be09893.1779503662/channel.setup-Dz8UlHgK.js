import { t as createZalouserPluginBase } from "./shared-3m3gJ__r.js";
import { n as zalouserSetupAdapter } from "./setup-core-D4NGhKW0.js";
import { t as zalouserSetupWizard } from "./setup-surface-C8m4Qlur.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
