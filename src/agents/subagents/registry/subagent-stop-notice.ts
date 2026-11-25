import { withSystemEventOwner } from "../../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { ExplicitRunStopSource } from "../../../sessions/session-run-stopped.js";

const STOP_NOTICE_SOURCES: Record<ExplicitRunStopSource, string> = {
  "client-session": "A session Stop from a connected app",
  "client-run": "A Stop of your turn",
  "channel-user": "A /stop command",
};
const STOP_NOTICE_MAX_LABELS = 10;

/**
 * An explicit Stop retires the cancelled children's completions, so the requester would never
 * learn they ended. Queue one notice for its next turn; the notice never starts a turn itself.
 */
export function enqueueStoppedSubagentsNotice(params: {
  source: ExplicitRunStopSource;
  requesterSessionKey: string;
  requesterAgentId: string;
  killed: number;
  labels: readonly string[];
}): void {
  if (params.killed <= 0) {
    return;
  }
  const shown = params.labels
    .slice(0, STOP_NOTICE_MAX_LABELS)
    .map((label) => label.replace(/\s+/g, " ").trim().slice(0, 80));
  const more = params.killed - shown.length;
  const names = shown.length ? `: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}` : "";
  enqueueSystemEvent(
    `${STOP_NOTICE_SOURCES[params.source]} cancelled ${params.killed} running ` +
      `${params.killed === 1 ? "sub-agent" : "sub-agents"}${names}. ` +
      "They won't report back. Check their sessions before you rely on their work, " +
      "and spawn them again if it's still needed.",
    withSystemEventOwner({ sessionKey: params.requesterSessionKey }, params.requesterAgentId),
  );
}
