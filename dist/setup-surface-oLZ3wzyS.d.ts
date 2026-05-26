import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { s as ChannelSetupWizard } from "./setup-wizard-types-DuBaq1ys.js";
import { H as ChannelSetupAdapter } from "./types.adapters-BulQCrMx.js";
//#region extensions/feishu/src/setup-core.d.ts
declare function setFeishuNamedAccountEnabled(cfg: OpenClawConfig, accountId: string, enabled: boolean): OpenClawConfig;
declare const feishuSetupAdapter: ChannelSetupAdapter;
//#endregion
//#region extensions/feishu/src/setup-surface.d.ts
type WizardPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
declare function runFeishuLogin(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig>;
declare const feishuSetupWizard: ChannelSetupWizard;
//#endregion
export { setFeishuNamedAccountEnabled as i, runFeishuLogin as n, feishuSetupAdapter as r, feishuSetupWizard as t };