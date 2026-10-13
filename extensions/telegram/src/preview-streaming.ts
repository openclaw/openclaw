import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingProgressCommentary,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveTelegramPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  // Telegram defaults to the progress draft: on tool-heavy turns a status draft
  // answers "is it working?", which streamed answer text cannot.
  // Operators who prefer streamed answer text set `streaming.mode: "partial"`.
  return resolveChannelPreviewStreamMode(params, "progress");
}

/**
 * Modifying outbound hooks suppress provider previews because a draft is visible
 * before they run. `progress.previewWithHooks` is an explicit operator waiver for
 * the progress draft only: its status headline, plan milestones, approval requests
 * and tool lines then reach Telegram without those hooks, while every durable
 * message still passes through them. The waiver never covers streamed answer text,
 * the commentary lane, or reasoning streamed into the draft.
 */
export function resolveTelegramProgressDraftWithHooks(params: {
  streaming?: unknown;
  streamMode: StreamingMode;
  reasoningLevel: "off" | "on" | "stream";
}): boolean {
  if (params.streamMode !== "progress" || params.reasoningLevel === "stream") {
    return false;
  }
  if (resolveChannelStreamingProgressCommentary(params, false, params.streamMode)) {
    return false;
  }
  return asOptionalRecord(asOptionalRecord(params.streaming)?.progress)?.previewWithHooks === true;
}
