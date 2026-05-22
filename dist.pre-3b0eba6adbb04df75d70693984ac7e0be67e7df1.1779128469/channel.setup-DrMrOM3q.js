import { t as createZalouserPluginBase } from "./shared-BRGZ9_gb.js";
import { n as zalouserSetupAdapter } from "./setup-core-D06a2CAp.js";
import { t as zalouserSetupWizard } from "./setup-surface-DD9sP-oS.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
