import { t as createZalouserPluginBase } from "./shared-BrysdKLf.js";
import { n as zalouserSetupAdapter } from "./setup-core-yAxApLz6.js";
import { t as zalouserSetupWizard } from "./setup-surface-C0ikS5jv.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
