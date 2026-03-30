import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { buildSlackInteractiveBlocks, type SlackBlock } from "./blocks-render.js";

export function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined {
  const slackData = payload.channelData?.slack;
  const interactiveBlocks = buildSlackInteractiveBlocks(payload.interactive);
  let channelBlocks: SlackBlock[] = [];
  if (slackData && typeof slackData === "object" && !Array.isArray(slackData)) {
    channelBlocks =
      (parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks) as SlackBlock[]) ?? [];
  }
  const blocks = [...channelBlocks, ...interactiveBlocks];
  return blocks.length > 0 ? blocks : undefined;
}
