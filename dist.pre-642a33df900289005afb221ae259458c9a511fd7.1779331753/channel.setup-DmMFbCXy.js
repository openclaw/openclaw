import { t as createZalouserPluginBase } from "./shared-D6XsUsi-.js";
import { n as zalouserSetupAdapter } from "./setup-core-DfHwr5u7.js";
import { t as zalouserSetupWizard } from "./setup-surface-SQPyUn_1.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
