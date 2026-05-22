import { r as AnyAgentTool } from "./common-D4gcZLB7.js";
import { D as OpenClawPluginToolContext } from "./types-core-Ct8aDHbu.js";
import { s as ChannelSetupWizard } from "./setup-wizard-types-DKDPCwx8.js";
import { H as ChannelSetupAdapter } from "./types.adapters-DJs2Vn2k.js";
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