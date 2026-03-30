import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
export { handleAutoCompactionEnd, handleAutoCompactionStart, } from "./pi-embedded-subscribe.handlers.compaction.js";
export declare function handleAgentStart(ctx: EmbeddedPiSubscribeContext): void;
export declare function handleAgentEnd(ctx: EmbeddedPiSubscribeContext): void;
