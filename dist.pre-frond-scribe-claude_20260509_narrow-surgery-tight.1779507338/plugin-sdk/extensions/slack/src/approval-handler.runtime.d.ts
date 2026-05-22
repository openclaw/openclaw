import type { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type SlackBlock = Block | KnownBlock;
type SlackPendingApproval = {
    channelId: string;
    messageTs: string;
};
type SlackPendingDelivery = {
    text: string;
    blocks: SlackBlock[];
};
type SlackExecApprovalConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"]>;
export type SlackApprovalHandlerContext = {
    app: App;
    config: SlackExecApprovalConfig;
};
export declare const slackApprovalNativeRuntime: import("openclaw/plugin-sdk/approval-handler-runtime").ChannelApprovalNativeRuntimeAdapter<SlackPendingDelivery, {
    to: string;
    threadTs?: string;
}, SlackPendingApproval, never, SlackPendingDelivery>;
export {};
