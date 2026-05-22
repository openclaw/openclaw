import { t as createZalouserPluginBase } from "./shared-CiSFQr3k.js";
import { n as zalouserSetupAdapter } from "./setup-core-ysY7vX53.js";
import { t as zalouserSetupWizard } from "./setup-surface-CwxlU126.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
