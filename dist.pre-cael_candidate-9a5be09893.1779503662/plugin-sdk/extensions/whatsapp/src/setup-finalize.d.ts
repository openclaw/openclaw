import { type OpenClawConfig } from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
type SetupPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
type SetupRuntime = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["runtime"];
export declare function finalizeWhatsAppSetup(params: {
    cfg: OpenClawConfig;
    accountId: string;
    forceAllowFrom: boolean;
    prompter: SetupPrompter;
    runtime: SetupRuntime;
}): Promise<{
    cfg: OpenClawConfig;
}>;
export {};
