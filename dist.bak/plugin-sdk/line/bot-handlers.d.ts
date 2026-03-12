import type { WebhookEvent } from "@line/bot-sdk";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { type LineInboundContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";
export interface LineHandlerContext {
    cfg: OpenClawConfig;
    account: ResolvedLineAccount;
    runtime: RuntimeEnv;
    mediaMaxBytes: number;
    processMessage: (ctx: LineInboundContext) => Promise<void>;
}
export declare function handleLineWebhookEvents(events: WebhookEvent[], context: LineHandlerContext): Promise<void>;
