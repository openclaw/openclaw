import { t as createZalouserPluginBase } from "./shared-twDW1voq.js";
import { n as zalouserSetupAdapter } from "./setup-core-Dl6B75Qy.js";
import { t as zalouserSetupWizard } from "./setup-surface-CrERFMGs.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
