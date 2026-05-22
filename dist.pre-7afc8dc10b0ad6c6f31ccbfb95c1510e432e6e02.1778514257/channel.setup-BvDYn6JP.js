import { t as createZalouserPluginBase } from "./shared-DSH4ZYBM.js";
import { n as zalouserSetupAdapter } from "./setup-core-Dd7sNZ8-.js";
import { t as zalouserSetupWizard } from "./setup-surface-DihAcRmp.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
