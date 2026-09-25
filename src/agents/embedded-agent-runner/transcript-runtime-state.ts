import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";

export type RuntimeTranscriptScope = SessionTranscriptRuntimeScope;
type RuntimeTranscriptTarget = SessionTranscriptRuntimeTarget;

/**
 * Resolves the runtime transcript target for read/probe operations without
 * linking missing file-backed metadata into the session store.
 */
export async function resolveRuntimeTranscriptReadTarget(
  scope: RuntimeTranscriptScope,
): Promise<RuntimeTranscriptTarget> {
  const target = await resolveSessionTranscriptRuntimeTarget(scope);
  const { restoreSessionColdTranscript } =
    await import("../../config/sessions/session-cold-storage.js");
  await restoreSessionColdTranscript({ ...target, ...(scope.env ? { env: scope.env } : {}) });
  return target;
}
