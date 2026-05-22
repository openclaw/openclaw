import type { Block, KnownBlock } from "@slack/web-api";
import type { InteractiveReply, MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
export type SlackBlock = Block | KnownBlock;
type SlackInteractiveBlockRenderOptions = {
    buttonIndexOffset?: number;
    selectIndexOffset?: number;
};
/** Resolve existing OpenClaw Block Kit indexes so appended controls keep stable unique IDs. */
export declare function resolveSlackInteractiveBlockOffsets(blocks?: readonly SlackBlock[]): SlackInteractiveBlockRenderOptions;
/**
 * @deprecated Use buildSlackPresentationBlocks with MessagePresentation.
 */
export declare function buildSlackInteractiveBlocks(interactive?: InteractiveReply, options?: SlackInteractiveBlockRenderOptions): SlackBlock[];
/** Render portable presentation blocks as Slack Block Kit blocks. */
export declare function buildSlackPresentationBlocks(presentation?: MessagePresentation, options?: SlackInteractiveBlockRenderOptions): SlackBlock[];
export {};
