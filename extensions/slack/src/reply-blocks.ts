import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
// Slack plugin module implements reply blocks behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { parseSlackBlocksInput, SLACK_MAX_BLOCKS } from "./blocks-input.js";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  canRenderSlackPresentationTables,
  resolveSlackBlockOffsets,
  type SlackBlock,
} from "./blocks-render.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";

export function resolveSlackReplyText(payload: ReplyPayload, text = payload.text): string {
  const presentation = normalizeMessagePresentation(payload.presentation);
  const hasStructuredData = presentation?.blocks.some(
    (block) => block.type === "chart" || block.type === "table",
  );
  return hasStructuredData
    ? renderSlackMessagePresentationFallbackText({ text, presentation })
    : (text ?? "");
}

export function resolveSlackReplyBlockResolution(payload: ReplyPayload): {
  blocks?: SlackBlock[];
  usesTableTextFallback: boolean;
} {
  const slackData = payload.channelData?.slack;
  let channelBlocks: SlackBlock[] = [];
  if (slackData && typeof slackData === "object" && !Array.isArray(slackData)) {
    channelBlocks =
      (parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks) as SlackBlock[]) ?? [];
  }
  const presentation = normalizeMessagePresentation(payload.presentation);
  const presentationOffsets = resolveSlackBlockOffsets(channelBlocks);
  const usesTableTextFallback = Boolean(
    presentation && !canRenderSlackPresentationTables(presentation, presentationOffsets),
  );
  const presentationBlocks = usesTableTextFallback
    ? []
    : buildSlackPresentationBlocks(presentation, presentationOffsets);
  const interactiveBlocks = buildSlackInteractiveBlocks(
    payload.interactive,
    resolveSlackBlockOffsets([...channelBlocks, ...presentationBlocks]),
  );
  const blocks = [...channelBlocks, ...presentationBlocks, ...interactiveBlocks];
  if (blocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack blocks cannot exceed ${SLACK_MAX_BLOCKS} items after interactive render`,
    );
  }
  // Table fallback changes presentation rendering, not raw block validity. Keep
  // ordinary Slack sends fail-closed instead of silently discarding authored blocks.
  return {
    ...(blocks.length > 0 ? { blocks } : {}),
    usesTableTextFallback,
  };
}

export function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined {
  return resolveSlackReplyBlockResolution(payload).blocks;
}
