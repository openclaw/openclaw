import { t as createZalouserPluginBase } from "./shared-CrMGhQN6.js";
import { n as zalouserSetupAdapter } from "./setup-core-DPWg5kvm.js";
import { t as zalouserSetupWizard } from "./setup-surface-4iOaIfWe.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
