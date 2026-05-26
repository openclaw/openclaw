import { t as createZalouserPluginBase } from "./shared-D7bv1QJU.js";
import { n as zalouserSetupAdapter } from "./setup-core-SEVjHNaY.js";
import { t as zalouserSetupWizard } from "./setup-surface-CE00Pwif.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
