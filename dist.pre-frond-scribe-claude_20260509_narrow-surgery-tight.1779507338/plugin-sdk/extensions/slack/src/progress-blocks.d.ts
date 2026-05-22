import type { Block, KnownBlock } from "@slack/web-api";
import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-streaming";
export declare function buildSlackProgressDraftBlocks(params: {
    label?: string;
    lines: readonly ChannelProgressDraftLine[];
    maxLineChars?: number;
}): (Block | KnownBlock)[] | undefined;
