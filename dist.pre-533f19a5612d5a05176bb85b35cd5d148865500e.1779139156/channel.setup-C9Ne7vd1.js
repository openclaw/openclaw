import { t as createZalouserPluginBase } from "./shared-RhsZ0SWU.js";
import { n as zalouserSetupAdapter } from "./setup-core-BEpLcql8.js";
import { t as zalouserSetupWizard } from "./setup-surface-Do1ZDMdH.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
