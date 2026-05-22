import type { Block, KnownBlock } from "@slack/web-api";
export declare function buildSlackEditTextPayload(content: string, blocks?: (Block | KnownBlock)[]): string;
