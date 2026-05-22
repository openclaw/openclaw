import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
export { handleCompactionEnd, handleCompactionStart, } from "./pi-embedded-subscribe.handlers.compaction.js";
export declare function handleAgentStart(ctx: EmbeddedPiSubscribeContext): void;
export declare function handleAgentEnd(ctx: EmbeddedPiSubscribeContext): void | Promise<void>;
