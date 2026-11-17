import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { MediaFact } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarness } from "./types.js";

const log = createSubsystemLogger("agent/input");

// Spill only what would not fit: a request that fits inline answers more reliably
// than one the model must read back from a file (gpt-5.4-mini found a middle-only
// fact 1/3 times from the attachment, gpt-5.4 3/3). History compaction owns the rest.
const CURRENT_INPUT_CONTEXT_SHARE = 0.9;
// Conservative: natural English measured ~3.9 chars per token, dense text less.
const CHARS_PER_TOKEN_ESTIMATE = 3;
const CURRENT_INPUT_FILE_NAME = "current-request.txt";
// Room for the attachment path note the host prepares.
const CURRENT_INPUT_NOTE_MAX_CHARS = 4_096;

/** Fits the current request for one harness attempt; the transcript keeps the original. */
export async function fitCurrentInputForHarness<
  T extends Pick<
    EmbeddedRunAttemptParams,
    "prompt" | "transcriptPrompt" | "contextTokenBudget" | "model" | "hostCapabilities"
  >,
>(params: T, harness: Pick<AgentHarness, "maxInputTextChars">): Promise<T> {
  const maxChars = resolveCurrentInputMaxChars({
    runtimeMaxChars: harness.maxInputTextChars,
    contextTokens: params.contextTokenBudget ?? params.model?.contextWindow,
  });
  if (maxChars === undefined || params.prompt.length <= maxChars) {
    return params;
  }
  const prepareInputAttachments = params.hostCapabilities?.prepareInputAttachments;
  const prompt = await fitOversizedCurrentInput({
    prompt: params.prompt,
    maxChars,
    ...(prepareInputAttachments
      ? {
          stageAttachment: (media: MediaFact[]) =>
            prepareInputAttachments({
              placement: "local-host",
              maxChars: CURRENT_INPUT_NOTE_MAX_CHARS,
              turn: { media },
              assertCurrent: () => {},
            }),
        }
      : {}),
  });
  return { ...params, prompt, transcriptPrompt: params.transcriptPrompt ?? params.prompt };
}

/** Largest current request sent inline: the runtime cap or most of the model window, whichever is smaller. */
export function resolveCurrentInputMaxChars(params: {
  runtimeMaxChars?: number;
  contextTokens?: number;
}): number | undefined {
  const contextChars =
    params.contextTokens && params.contextTokens > 0
      ? Math.floor(params.contextTokens * CURRENT_INPUT_CONTEXT_SHARE * CHARS_PER_TOKEN_ESTIMATE)
      : undefined;
  const limits = [params.runtimeMaxChars, contextChars].filter(
    (value): value is number => value !== undefined && value > 0,
  );
  return limits.length ? Math.min(...limits) : undefined;
}

/**
 * Fit an oversized current request. The full text is staged as a readable
 * attachment when this run may read files; the model sees its head and tail,
 * which carry the instruction and both untrusted-content markers. Without a
 * readable attachment only the middle is cut. Callers keep the original as the
 * transcript prompt.
 */
export async function fitOversizedCurrentInput(params: {
  prompt: string;
  maxChars: number;
  stageAttachment?: (media: MediaFact[]) => Promise<string | undefined>;
}): Promise<string> {
  const { prompt, maxChars } = params;
  if (prompt.length <= maxChars) {
    return prompt;
  }
  let note: string | undefined;
  if (params.stageAttachment) {
    try {
      const saved = await saveMediaBuffer(
        Buffer.from(prompt, "utf8"),
        "text/plain",
        "inbound",
        undefined,
        CURRENT_INPUT_FILE_NAME,
      );
      note = await params.stageAttachment([
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
