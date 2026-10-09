import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptReadSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
  SessionManagerTranscriptCohort,
} from "./session-manager-view-types.js";

export function consumeSessionManagerReload(
  prepared: PreparedSessionTranscriptReload,
  consume: SessionManagerTranscriptCohort["consume"] | undefined,
  captureView: () => object,
  assertCurrent: () => void,
): void {
  const adopted = captureView();
  const consumed = consume?.(prepared, () => {
    assertCurrent();
    const current = captureView();
    if (
      Object.keys(adopted).some((key) => Reflect.get(adopted, key) !== Reflect.get(current, key))
    ) {
      throw new Error("Session manager changed after transcript cohort adoption");
    }
  });
  if (isPromiseLike(consumed)) {
    void Promise.resolve(consumed).catch(() => {});
    throw new Error("Transcript cohort consumers must remain synchronous");
  }
}

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
