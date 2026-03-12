import type { EmbeddedPiSubscribeContext, EmbeddedPiSubscribeEvent } from "./pi-embedded-subscribe.handlers.types.js";
export declare function createEmbeddedPiSessionEventHandler(ctx: EmbeddedPiSubscribeContext): (evt: EmbeddedPiSubscribeEvent) => void;
