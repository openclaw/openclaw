import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { MediaFact } from "../../media/media-facts.js";

const log = createSubsystemLogger("agent/input");

// Spill only what would not fit: a request that fits inline answers more reliably
// than one the model must read back from a file (gpt-5.4-mini found a middle-only
// fact 1/3 times from the attachment, gpt-5.4 3/3). History compaction owns the rest.
const INPUT_WINDOW_SHARE = 0.9;
// Conservative chars per token: natural English measured 3.9-4.5, dense text less.
const ATTACH_CHARS_PER_TOKEN = 3;
// Without an attachment, cut only a request that would clearly overflow the window.
const CUT_CHARS_PER_TOKEN = 4;
const CURRENT_INPUT_FILE_NAME = "current-request.txt";
// Room for the attachment path note the host prepares.
const CURRENT_INPUT_NOTE_MAX_CHARS = 4_096;

export type CurrentInputBudget = { attachMaxChars: number; cutMaxChars: number };
/** Returns the host note with the staged path, bounded by noteMaxChars, or undefined. */
export type StageCurrentInputAttachment = (
  noteMaxChars: number,
  media: MediaFact[],
) => Promise<string | undefined>;

/** Inline limits for the current request from the runtime cap and the model's input window. */
export function resolveCurrentInputBudget(params: {
  runtimeMaxChars?: number;
  contextTokens?: number;
  /** The model's reply allowance comes out of the same window. */
  maxOutputTokens?: number;
}): CurrentInputBudget | undefined {
  const cap =
    params.runtimeMaxChars && params.runtimeMaxChars > 0 ? params.runtimeMaxChars : Infinity;
  const tokens =
    params.contextTokens && params.contextTokens > 0 ? params.contextTokens : undefined;
  const inputTokens = tokens
    ? (tokens - Math.min(Math.max(0, params.maxOutputTokens ?? 0), tokens / 2)) * INPUT_WINDOW_SHARE
    : Infinity;
  const attachMaxChars = Math.floor(Math.min(cap, inputTokens * ATTACH_CHARS_PER_TOKEN));
  const cutMaxChars = Math.floor(Math.min(cap, inputTokens * CUT_CHARS_PER_TOKEN));
  return Number.isFinite(attachMaxChars) ? { attachMaxChars, cutMaxChars } : undefined;
}

/**
 * Fit an oversized current request. When the caller can stage a readable
 * attachment, the full text is saved and the model sees its head, tail and the
 * attachment path. Otherwise only a request that cannot fit loses its middle.
 * The head and tail carry the instruction and both untrusted-content markers.
 * Callers keep the original as the transcript prompt.
 */
export async function fitOversizedCurrentInput(params: {
  prompt: string;
  budget: CurrentInputBudget;
  /** Placement-aware staging owned by the harness; undefined when the run cannot read it. */
  stageAttachment?: StageCurrentInputAttachment;
}): Promise<string> {
  const { prompt, budget } = params;
  if (prompt.length <= budget.attachMaxChars) {
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
      log.warn("current input attachment unavailable; keeping it inline", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const maxChars = note ? budget.attachMaxChars : budget.cutMaxChars;
  if (!note && prompt.length <= maxChars) {
    return prompt;
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

/** Applies {@link fitOversizedCurrentInput} to attempt params; the transcript keeps the original. */
export async function fitCurrentInputPrompt<
  T extends { prompt: string; transcriptPrompt?: string },
>(
  params: T,
  budget: CurrentInputBudget | undefined,
  stageAttachment?: StageCurrentInputAttachment,
): Promise<T> {
  if (!budget || params.prompt.length <= budget.attachMaxChars) {
    return params;
  }
  const prompt = await fitOversizedCurrentInput({
    prompt: params.prompt,
    budget,
    ...(stageAttachment ? { stageAttachment } : {}),
  });
  return prompt === params.prompt
    ? params
    : { ...params, prompt, transcriptPrompt: params.transcriptPrompt ?? params.prompt };
}
