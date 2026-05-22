import { t as createZalouserPluginBase } from "./shared-CEyTzwI1.js";
import { n as zalouserSetupAdapter } from "./setup-core-BSsKg6su.js";
import { t as zalouserSetupWizard } from "./setup-surface-DNKMbnF8.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
