import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { findSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import { withSessionTranscriptHydrationCaller } from "../../config/sessions/session-transcript-hydration-caller.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";

/** Manual preflight metadata and its selected transcript share the existing read admission. */
export async function readSessionManagerCompaction(
  target: SessionTranscriptRuntimeTarget,
  options: { cwd?: string; signal?: AbortSignal; metadataOnly?: boolean },
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
  const context = { ...prepared.snapshot, limits };
  return {
    ...prepared.compaction,
    eventCount: context.totalEvents,
    metadataOnly: options.metadataOnly === true && context.truncated,
    cwd: options.cwd ?? findSessionTranscriptHeader(context.events)?.cwd ?? process.cwd(),
    context,
  };
}
