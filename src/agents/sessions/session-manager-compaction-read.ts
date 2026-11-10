import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { withSessionTranscriptHydrationCaller } from "../../config/sessions/session-transcript-hydration-caller.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";

/** Manual preflight metadata and its selected transcript share the existing read admission. */
export async function readSessionManagerCompaction(
  target: SessionTranscriptRuntimeTarget,
  options: { signal?: AbortSignal; metadataOnly?: boolean },
) {
  const { signal } = options;
  const limits = options.metadataOnly
    ? { maxEvents: 256, maxBytes: 1024 * 1024 }
    : { compaction: true as const };
  const hydration = withSessionTranscriptHydrationCaller("compaction", () =>
    prepareSessionTranscriptHydration(target, limits, signal),
  );
  const prepared = await hydration.read({ compaction: true });
  if (prepared.kind !== "bounded" || !prepared.compaction) {
    throw new Error("Expected a prepared compaction transcript");
  }
  return { compaction: prepared.compaction, context: { ...prepared.snapshot, limits } };
}
