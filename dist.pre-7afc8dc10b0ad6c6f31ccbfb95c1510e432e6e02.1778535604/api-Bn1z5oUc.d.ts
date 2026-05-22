import { r as AnyAgentTool } from "./common-BTwhyOZ1.js";
import { C as OpenClawPluginToolContext } from "./types-core-aEWdlOh5.js";
import { s as ChannelSetupWizard } from "./setup-wizard-types-DaXLDmsS.js";
import { H as ChannelSetupAdapter } from "./types.adapters-BLIJ2aQP.js";
//#region extensions/zalouser/src/tool.d.ts
type ZalouserToolContext = Pick<OpenClawPluginToolContext, "deliveryContext">;
declare function createZalouserTool(context?: ZalouserToolContext): AnyAgentTool;
//#endregion
//#region extensions/zalouser/src/setup-core.d.ts
declare const zalouserSetupAdapter: ChannelSetupAdapter;
declare function createZalouserSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>): ChannelSetupWizard;
//#endregion
//#region extensions/zalouser/src/setup-surface.d.ts
declare const zalouserSetupWizard: ChannelSetupWizard;
//#endregion
export { createZalouserTool as i, createZalouserSetupWizardProxy as n, zalouserSetupAdapter as r, zalouserSetupWizard as t };