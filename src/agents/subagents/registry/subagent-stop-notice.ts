import { withSystemEventOwner } from "../../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { ExplicitRunStopSource } from "../../../sessions/session-run-stopped.js";

const STOP_NOTICE_SOURCES: Record<ExplicitRunStopSource, string> = {
  "client-session": "An explicit session Stop from a connected app",
  "client-run": "An explicit Stop of your turn",
  "channel-user": "A user /stop command",
};
const STOP_NOTICE_MAX_LABELS = 10;

/**
 * An explicit Stop retires the canceled children's completions, so the requester would never
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
    .map((label) => label.replace(/\s+/g, " ").trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, STOP_NOTICE_MAX_LABELS);
  const more = params.killed - shown.length;
  let names = shown.join(", ");
  if (more > 0 && shown.length > 0) {
    names += `${shown.length === 1 ? "" : ","} and ${more} more`;
  }
  const one = params.killed === 1;
  enqueueSystemEvent(
    `${STOP_NOTICE_SOURCES[params.source]} canceled ${params.killed} running ` +
      `${one ? "sub-agent" : "sub-agents"}${names ? `: ${names}` : ""}. ` +
      (one
        ? "It won't report back. Check its session before relying on any partial work, " +
          "and don't restart it unless the user asks."
        : "They won't report back. Check their sessions before relying on any partial work, " +
          "and don't restart them unless the user asks."),
    withSystemEventOwner({ sessionKey: params.requesterSessionKey }, params.requesterAgentId),
  );
}
