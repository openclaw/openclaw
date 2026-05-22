import { t as createZalouserPluginBase } from "./shared-D9BxlUE_.js";
import { n as zalouserSetupAdapter } from "./setup-core-Cj3EBJnq.js";
import { t as zalouserSetupWizard } from "./setup-surface-8Likjg3s.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
