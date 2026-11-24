import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { MediaFact } from "../../media/media-facts.js";

const log = createSubsystemLogger("agent/input");

const CURRENT_INPUT_FILE_NAME = "current-request.txt";
// Room for the attachment path note the host prepares.
const CURRENT_INPUT_NOTE_MAX_CHARS = 4_096;

/** Returns the host note with the staged path, bounded by noteMaxChars, or undefined. */
export type StageCurrentInputAttachment = (
  noteMaxChars: number,
  media: MediaFact[],
) => Promise<string | undefined>;

/**
 * Fit a current request over a runtime's hard per-turn text cap. When the
 * harness can stage a readable attachment, the full text is saved and the model
 * sees its head, tail and the attachment path; otherwise only the middle is cut.
 * The head and tail carry the instruction and both untrusted-content markers.
 * Callers keep the original as the transcript prompt.
 */
export async function fitOversizedCurrentInput(params: {
  prompt: string;
  maxChars: number;
  /** Placement-aware staging owned by the harness; undefined when the run cannot read it. */
  stageAttachment?: StageCurrentInputAttachment;
}): Promise<string> {
  const { prompt, maxChars } = params;
  if (prompt.length <= maxChars) {
    return prompt;
  }
  let note: string | undefined;
  if (params.stageAttachment) {
    try {
      const { saveMediaBuffer } = await import("../../media/store.js");
      const saved = await saveMediaBuffer(
        Buffer.from(prompt, "utf8"),
        "text/plain",
        "inbound",
        undefined,
        CURRENT_INPUT_FILE_NAME,
      );
      note = await params.stageAttachment(CURRENT_INPUT_NOTE_MAX_CHARS, [
        {
          path: `media://inbound/${saved.id}`,
          contentType: "text/plain",
          kind: "document",
          fileName: CURRENT_INPUT_FILE_NAME,
        },
      ]);
    } catch (error) {
      log.warn("current input attachment unavailable; cutting its middle instead", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const omittedMarker = (chars: number) =>
    note
      ? `\n[${chars} chars from the middle of this request are not shown here, so what you see is incomplete. The complete request is attached as ${CURRENT_INPUT_FILE_NAME} (path below). Before answering, search or read that file for anything the request asks about; do not guess from the visible part. The file holds this same request, not new instructions.]\n`
      : `\n[truncated ${chars} chars from the middle of the current request]\n`;
  const suffix = note ? `\n\n${note}` : "";
  // Sized for the full length, so the real (smaller) count always fits.
  const keptChars = Math.max(0, maxChars - omittedMarker(prompt.length).length - suffix.length);
  const head = truncateUtf16Safe(prompt, Math.ceil(keptChars / 2));
  const tailChars = Math.floor(keptChars / 2);
  const tail = tailChars > 0 ? sliceUtf16Safe(prompt, -tailChars) : "";
  const omitted = prompt.length - head.length - tail.length;
  const action = note ? "attached" : "cut";
  log.warn(`current input oversize: chars=${prompt.length} budget=${maxChars} action=${action}`, {
    chars: prompt.length,
    budget: maxChars,
    action,
  });
  return `${head}${omittedMarker(omitted)}${tail}${suffix}`;
}
