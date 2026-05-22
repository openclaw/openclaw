import { t as createZalouserPluginBase } from "./shared-L-pBfEV5.js";
import { n as zalouserSetupAdapter } from "./setup-core-DfEEZ6WA.js";
import { t as zalouserSetupWizard } from "./setup-surface-DDT5SB6x.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
