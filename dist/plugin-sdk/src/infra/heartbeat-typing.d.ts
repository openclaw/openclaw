import type { ChannelHeartbeatDeps, ChannelPlugin } from "../channels/plugins/types.public.js";
import { type TypingCallbacks } from "../channels/typing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type HeartbeatTypingLogger = {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
};
type HeartbeatTypingTarget = {
    channel: string;
    to?: string;
    accountId?: string | null;
    threadId?: string | number | null;
};
export declare function createHeartbeatTypingCallbacks(params: {
    cfg: OpenClawConfig;
    target: HeartbeatTypingTarget;
    plugin?: Pick<ChannelPlugin, "heartbeat">;
    deps?: ChannelHeartbeatDeps;
    typingIntervalSeconds?: number;
    log?: HeartbeatTypingLogger;
}): TypingCallbacks | undefined;
export {};
