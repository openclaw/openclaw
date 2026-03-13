import type { Block, KnownBlock } from "@slack/web-api";
export declare function validateSlackBlocksArray(raw: unknown): (Block | KnownBlock)[];
export declare function parseSlackBlocksInput(raw: unknown): (Block | KnownBlock)[] | undefined;
