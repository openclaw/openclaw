import { t as createZalouserPluginBase } from "./shared-Cndetg74.js";
import { n as zalouserSetupAdapter } from "./setup-core-Ds28dc3A.js";
import { t as zalouserSetupWizard } from "./setup-surface-IYIdjdwn.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
