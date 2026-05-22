import type { Block, KnownBlock } from "@slack/web-api";
export declare const SLACK_MAX_BLOCKS = 50;
export declare function validateSlackBlocksArray(raw: unknown): (Block | KnownBlock)[];
export declare function parseSlackBlocksInput(raw: unknown): (Block | KnownBlock)[] | undefined;
