import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareSessionTranscriptHydration } from "../../../config/sessions/session-transcript-hydration.js";
import {
  sameSessionTranscriptTargetBinding,
  type SessionTranscriptTargetBinding,
} from "../../../config/sessions/transcript-target-binding.js";
import {
  readNestedToolActivity,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import type { SessionManager } from "../../sessions/session-manager.js";

export type AttemptNestedToolActivityState = {
  scopeId: string;
  successfulToolNames: Set<string>;
  accepted?: {
    firstEntryId: string;
    lastEntryId: string;
    sessionId: string;
    target?: SessionTranscriptTargetBinding;
  };
};

export function createAttemptNestedToolActivityState(): AttemptNestedToolActivityState {
  return { scopeId: randomUUID(), successfulToolNames: new Set() };
}

/** Rehydrate accepted hook evidence only at delivery; SQLite owns the payload between calls. */
export async function readAttemptNestedToolActivity(
  manager: Pick<SessionManager, "getEntries" | "getSessionId" | "getSessionTarget">,
  state: AttemptNestedToolActivityState,
): Promise<NestedToolActivity[]> {
  const accepted = state.accepted;
  if (!accepted) {
    return [];
  }
  const { firstEntryId, lastEntryId, sessionId, target } = accepted;
  const assertCurrent = () => {
    if (
      manager.getSessionId() !== sessionId ||
      !sameSessionTranscriptTargetBinding(target, manager.getSessionTarget())
    ) {
      throw new Error("Nested tool activity belongs to a replaced session");
    }
  };
  assertCurrent();
  const hydration = target && prepareSessionTranscriptHydration(target);
  const entries = hydration
    ? ((
        await hydration.readMaintenance({
          operation: "nested-activity",
          scopeId: state.scopeId,
          firstEntryId,
          lastEntryId,
        })
      ).events ?? [])
    : manager.getEntries();
  hydration?.assertCurrent();
  assertCurrent();
  const first = entries.findIndex((entry) => asOptionalRecord(entry)?.id === firstEntryId);
  const last = entries.findIndex((entry) => asOptionalRecord(entry)?.id === lastEntryId);
  if (first < 0 || last < first) {
    throw new Error("Accepted nested tool activity is no longer available");
  }
  return entries.slice(first, last + 1).flatMap((entry) => {
    const activity = readNestedToolActivity(asOptionalRecord(entry)?.message);
    return activity?.details.scopeId === state.scopeId ? [activity] : [];
  });
}
