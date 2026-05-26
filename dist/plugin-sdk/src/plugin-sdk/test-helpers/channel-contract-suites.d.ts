import type { ChannelAccountSnapshot, ChannelAccountState, ChannelSetupInput } from "../../channels/plugins/types.core.js";
import type { ChannelMessageActionName, ChannelMessageCapability, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
export declare function installChannelPluginContractSuite(params: {
    plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
}): void;
export declare function expectChannelPluginContract(plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">): void;
type ChannelActionsContractCase = {
    name: string;
    cfg: OpenClawConfig;
    expectedActions: readonly ChannelMessageActionName[];
    expectedCapabilities?: readonly ChannelMessageCapability[];
    beforeTest?: () => void;
};
export declare function installChannelActionsContractSuite(params: {
    plugin: Pick<ChannelPlugin, "id" | "actions">;
    cases: readonly ChannelActionsContractCase[];
    unsupportedAction?: ChannelMessageActionName;
}): void;
type ChannelSetupContractCase<ResolvedAccount> = {
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    input: ChannelSetupInput;
    expectedAccountId?: string;
    expectedValidation?: string | null;
    beforeTest?: () => void;
    assertPatchedConfig?: (cfg: OpenClawConfig) => void;
    assertResolvedAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => void;
};
export declare function installChannelSetupContractSuite<ResolvedAccount>(params: {
    plugin: Pick<ChannelPlugin<ResolvedAccount>, "id" | "config" | "setup">;
    cases: readonly ChannelSetupContractCase<ResolvedAccount>[];
}): void;
type ChannelStatusContractCase<Probe> = {
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    runtime?: ChannelAccountSnapshot;
    probe?: Probe;
    beforeTest?: () => void;
    expectedState?: ChannelAccountState;
    resolveStateInput?: {
        configured: boolean;
        enabled: boolean;
    };
    assertSnapshot?: (snapshot: ChannelAccountSnapshot) => void;
    assertSummary?: (summary: Record<string, unknown>) => void;
};
export declare function installChannelStatusContractSuite<ResolvedAccount, Probe = unknown>(params: {
    plugin: Pick<ChannelPlugin<ResolvedAccount, Probe>, "id" | "config" | "status">;
    cases: readonly ChannelStatusContractCase<Probe>[];
}): void;
export {};
