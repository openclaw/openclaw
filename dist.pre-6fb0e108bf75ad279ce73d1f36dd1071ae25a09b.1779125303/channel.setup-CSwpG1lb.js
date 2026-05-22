import { t as createZalouserPluginBase } from "./shared-BvOrIndE.js";
import { n as zalouserSetupAdapter } from "./setup-core-BGZ9EPmf.js";
import { t as zalouserSetupWizard } from "./setup-surface-Bc3YC324.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
