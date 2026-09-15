// Feishu-specific structured lines for the shared progress-draft compositor.
// Draft text itself comes from the compositor's shared formatter
// (formatChannelProgressDraftTextForStreaming), so the streaming card renders
// the same compact progress layout as the other draft-based channels.
import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";

const FEISHU_COMPACTION_PROGRESS_ID = "context-compaction";

export function buildFeishuCompactionProgressLine(
  phase: "start" | "complete" | "incomplete",
): ChannelProgressDraftLine {
  const label = {
    start: "Compacting context...",
    complete: "Compaction complete",
    incomplete: "Compaction incomplete",
  }[phase];
  return {
    id: FEISHU_COMPACTION_PROGRESS_ID,
    kind: "item",
    icon: "🧹",
    label,
    text: `🧹 ${label}`,
    prefix: false,
  };
}

/**
 * Drops the rotating status label ("Working" and friends) from a composed
 * draft when append finalize retains the progress lines: the label describes
 * an in-flight turn and reads wrong once the final answer has landed.
 */
export function stripFeishuProgressLabel(draftText: string, label?: string): string {
  if (!label || !draftText.startsWith(label)) {
    return draftText;
  }
  return draftText.slice(label.length).replace(/^\n+/, "");
}
