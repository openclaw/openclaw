import { t as createZalouserPluginBase } from "./shared-t8Xynr12.js";
import { n as zalouserSetupAdapter } from "./setup-core-z3BLuO_4.js";
import { t as zalouserSetupWizard } from "./setup-surface-Co4NZi5Q.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
