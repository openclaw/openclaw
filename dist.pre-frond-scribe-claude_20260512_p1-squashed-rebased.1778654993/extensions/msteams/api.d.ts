import { s as ChannelSetupWizard } from "../../setup-wizard-types-BP91fy0_.js";
import { H as ChannelSetupAdapter } from "../../types.adapters-DcVjcbEK.js";
import { t as msteamsPlugin } from "../../channel-qE0bXuNK.js";

//#region extensions/msteams/src/setup-core.d.ts
declare const msteamsSetupAdapter: ChannelSetupAdapter;
declare function createMSTeamsSetupWizardBase(): Pick<ChannelSetupWizard, "channel" | "resolveAccountIdForConfigure" | "resolveShouldPromptAccountIds" | "status" | "credentials" | "finalize">;
//#endregion
//#region extensions/msteams/src/setup-surface.d.ts
declare function openDelegatedOAuthUrl(url: string): Promise<void>;
declare const msteamsSetupWizard: ChannelSetupWizard;
//#endregion
export { createMSTeamsSetupWizardBase, msteamsPlugin, msteamsSetupAdapter, msteamsSetupWizard, openDelegatedOAuthUrl };