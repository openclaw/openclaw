import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptReadSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

export function readSessionManagerReload(
  target: SessionTranscriptRuntimeTarget,
  limits: SessionManagerBoundedContextLimits | undefined,
  ignoreReadFence: boolean,
): PreparedSessionTranscriptReload {
  if (limits) {
    return {
      kind: "bounded",
      snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
        ...limits,
        ...(ignoreReadFence ? { ignoreReadFence: true } : {}),
      }),
    };
  }
  if (!ignoreReadFence) {
    return { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target) };
  }
  const { events, snapshot } = inspectTranscriptEventsSync(target);
  return {
    kind: "full",
    snapshot: {
      events,
      version: {
        generation: snapshot.generation,
        rawSeq: snapshot.lastSeq,
        updatedAt: snapshot.transcriptUpdatedAt,
      },
    },
  };
}
