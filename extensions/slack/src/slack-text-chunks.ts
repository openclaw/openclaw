// Slack plugin module owns the canonical outbound text chunk plan.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";

export function resolveSlackTextChunks(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  text: string;
  textLimit?: number;
}): string[] {
  const text = params.text.trim();
  const configuredLimit =
    params.textLimit ??
    resolveTextChunkLimit(params.cfg, "slack", params.accountId, {
      fallbackLimit: SLACK_TEXT_LIMIT,
    });
  const chunkLimit = Math.min(configuredLimit, SLACK_TEXT_LIMIT);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "slack",
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  const chunkMode = resolveChunkMode(params.cfg, "slack", params.accountId);
  const markdownChunks =
    chunkMode === "newline" ? chunkMarkdownTextWithMode(text, chunkLimit, chunkMode) : [text];
  const chunks = markdownChunks.flatMap((markdown) =>
    markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }),
  );
  return resolveTextChunksWithFallback(text, chunks);
}
