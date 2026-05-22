import { t as createZalouserPluginBase } from "./shared-BDkCmmO4.js";
import { n as zalouserSetupAdapter } from "./setup-core-D06a2CAp.js";
import { t as zalouserSetupWizard } from "./setup-surface-Cm3UqaBU.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
