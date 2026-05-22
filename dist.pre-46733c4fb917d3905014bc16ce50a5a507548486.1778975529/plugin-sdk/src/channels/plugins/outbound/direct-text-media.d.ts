import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import type { OutboundMediaAccess } from "../../../media/load-options.js";
import type { ChannelOutboundAdapter } from "../types.adapters.js";
type DirectSendOptions = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    replyToId?: string | null;
    mediaUrl?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    maxBytes?: number;
};
type DirectSendResult = {
    messageId: string;
    [key: string]: unknown;
};
type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (to: string, text: string, opts: TOpts) => Promise<TResult>;
export { resolvePayloadMediaUrls, sendPayloadMediaSequence, sendPayloadMediaSequenceAndFinalize, sendPayloadMediaSequenceOrFallback, sendTextMediaPayload, } from "openclaw/plugin-sdk/reply-payload";
export declare function resolveScopedChannelMediaMaxBytes(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    resolveChannelLimitMb: (params: {
        cfg: OpenClawConfig;
        accountId: string;
    }) => number | undefined;
}): number | undefined;
export declare function createScopedChannelMediaMaxBytesResolver(channel: string): (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}) => number | undefined;
export declare function createDirectTextMediaOutbound<TOpts extends Record<string, unknown>, TResult extends DirectSendResult>(params: {
    channel: string;
    resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
    resolveMaxBytes: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => number | undefined;
    buildTextOptions: (params: DirectSendOptions) => TOpts;
    buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter;
