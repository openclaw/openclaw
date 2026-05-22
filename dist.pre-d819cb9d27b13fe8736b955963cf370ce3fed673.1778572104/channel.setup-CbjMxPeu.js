import { t as createZalouserPluginBase } from "./shared-Dh3LRRBu.js";
import { n as zalouserSetupAdapter } from "./setup-core-YRznieDB.js";
import { t as zalouserSetupWizard } from "./setup-surface-BeqWw-_X.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
