import type { ChannelAccountSnapshot, ChannelGatewayContext, OpenClawConfig, RuntimeEnv } from "../testing.js";
export declare function createStartAccountContext<TAccount extends {
    accountId: string;
}>(params: {
    account: TAccount;
    abortSignal?: AbortSignal;
    cfg?: OpenClawConfig;
    runtime?: RuntimeEnv;
    statusPatchSink?: (next: ChannelAccountSnapshot) => void;
}): ChannelGatewayContext<TAccount>;
