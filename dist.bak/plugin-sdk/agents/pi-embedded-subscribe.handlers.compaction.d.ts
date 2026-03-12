import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
export declare function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext): void;
export declare function handleAutoCompactionEnd(ctx: EmbeddedPiSubscribeContext, evt: AgentEvent & {
    willRetry?: unknown;
}): void;
