import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackChannelConfigEntries } from "../channel-config.js";
export declare function createInboundSlackTestContext(params: {
    cfg: OpenClawConfig;
    appClient?: App["client"];
    defaultRequireMention?: boolean;
    replyToMode?: "off" | "all" | "first" | "batched";
    channelsConfig?: SlackChannelConfigEntries;
    threadRequireExplicitMention?: boolean;
    dmHistoryLimit?: number;
}): import("../context.js").SlackMonitorContext;
export declare function createSlackTestAccount(config?: ResolvedSlackAccount["config"]): ResolvedSlackAccount;
export declare function createSlackSessionStoreFixture(prefix: string): {
    setup(): void;
    cleanup(): void;
    makeTmpStorePath(): {
        dir: string;
        storePath: string;
    };
};
