import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { findExternalContentFrames } from "../../security/external-content.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  writePrivateTempFile,
  type PrivateTempFileOptions,
} from "../sessions/tools/private-temp-file.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  resolveToolResultBudget,
  type ToolResultBudget,
} from "../tool-result-limits.js";
import { log } from "./logger.js";
import {
  estimateMessageChars,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
} from "./tool-result-char-estimator.js";
import {
  estimateToolResultTextChars,
  isToolResultTextBlock,
  sliceToolResultTextTailToBudget,
  sliceToolResultTextToBudget,
} from "./tool-result-text-budget.js";
import {
  formatOmittedCharsNotice,
  getToolResultSpillDetails,
  truncateToolResultMessage,
} from "./tool-result-truncation.js";

// The context guard's weighting of a tool result's visible content.
const SHAPE: AgentMessage = {
  role: "toolResult",
  toolCallId: "",
  toolName: "",
  content: [],
  isError: false,
  timestamp: 0,
};
const contextChars = (content: unknown[]) => estimateMessageChars(SHAPE, content);

// Context-guard weight of text: estimateMessageChars weighs tool-result text by this floor.
const WEIGHTED = { minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE };
const ELISION = "\n…\n";

/** Head and tail of `text` within both remaining budgets, and how many of its chars they keep. */
function keepEnds(text: string, chars: number, context: number) {
  const roomChars = chars - estimateToolResultTextChars(ELISION);
  const roomContext = context - estimateToolResultTextChars(ELISION, WEIGHTED);
  if (roomChars <= 0 || roomContext <= 0) {
    return { text: "", kept: 0 };
  }
  const half = (slice: typeof sliceToolResultTextToBudget) =>
    slice(slice(text, Math.floor(roomChars / 2)), Math.floor(roomContext / 2), WEIGHTED);
  const head = half(sliceToolResultTextToBudget);
  const tail = half(sliceToolResultTextTailToBudget);
  return { text: `${head}${ELISION}${tail}`, kept: head.length + tail.length };
}

/**
 * Bounds a result whose text carries untrusted-content frames (one per text block, or several
 * wrapped values inside one JSON block). It fails closed: text and whole frames are kept in order
 * while they fit; the first piece that does not fit keeps its head and tail (a frame keeps its
 * warning and both markers, and only its body is cut, or is left out whole when even those do
 * not fit); everything after it is left out. One trusted notice with the true omitted count
 * follows the cut, outside every frame, in the block that was cut, so no block is added.
 */
function cutFrames<T extends { content: unknown[] }>(
  result: T,
  budget: ToolResultBudget,
  nonText: number,
  suffix: (omittedChars: number) => string,
): T {
  const allText = result.content.reduce<number>(
    (sum, block) => sum + (isToolResultTextBlock(block) ? block.text.length : 0),
    0,
  );
  const largestNotice = `\n\n${suffix(allText)}`;
  let chars = budget.maxChars - estimateToolResultTextChars(largestNotice);
  // Images the share cannot hold at all are dropped by the context guard; text must then fit alone.
  let context =
    budget.maxContextChars -
    (nonText < budget.maxContextChars ? nonText : 0) -
    estimateToolResultTextChars(largestNotice, WEIGHTED);
  const take = (text: string) => {
    const textChars = estimateToolResultTextChars(text);
    const textContext = estimateToolResultTextChars(text, WEIGHTED);
    if (textChars > chars || textContext > context) {
      return false;
    }
    chars -= textChars;
    context -= textContext;
    return true;
  };
  let omitted = 0;
  let stopped = false;
  const content = result.content.flatMap((block) => {
    if (!isToolResultTextBlock(block)) {
      return [block];
    }
    if (stopped) {
      omitted += block.text.length;
      return [];
    }
    // Text between frames, then each frame as [ends before body, body, ends after body].
    const pieces: Array<[string, string, string]> = [];
    let at = 0;
    for (const frame of findExternalContentFrames(block.text)) {
      pieces.push(["", block.text.slice(at, frame.start), ""]);
      pieces.push([
        block.text.slice(frame.start, frame.bodyStart),
        block.text.slice(frame.bodyStart, frame.bodyEnd),
        block.text.slice(frame.bodyEnd, frame.end),
      ]);
      at = frame.end;
    }
    pieces.push(["", block.text.slice(at), ""]);
    let kept = "";
    for (const [open, body, close] of pieces) {
      if (stopped) {
        omitted += open.length + body.length + close.length;
      } else if (take(`${open}${body}${close}`)) {
        kept += `${open}${body}${close}`;
      } else {
        stopped = true;
        if (take(`${open}${close}`)) {
          const middle = keepEnds(body, chars, context);
          take(middle.text);
          kept += `${open}${middle.text}${close}`;
          omitted += body.length - middle.kept;
        } else {
          omitted += open.length + body.length + close.length;
        }
      }
    }
    return kept === block.text
      ? [block]
      : [{ ...block, text: kept, ...(typeof block.content === "string" ? { content: kept } : {}) }];
  });
  if (omitted === 0) {
    return result;
  }
  // The notice goes into the block that was cut: the last text block kept.
  const index = content.findLastIndex((block) => isToolResultTextBlock(block));
  const cut = content[index];
  if (isToolResultTextBlock(cut)) {
    const notice = sliceToolResultTextToBudget(suffix(omitted), budget.maxChars);
    const text = cut.text ? `${cut.text}\n\n${notice}` : notice;
    content[index] = {
      ...cut,
      text,
      ...(typeof cut.content === "string" ? { content: text } : {}),
    };
  }
  return { ...result, content };
}

/**
 * Bounds a fresh tool result once, before its first send, on every route. The budget is the
 * strictest one the result meets later: the per-result cap and the context guard's weighted
 * share (images and other blocks reserved first), so neither re-cuts a bounded result.
 * Text without untrusted-content frames keeps head and tail; text with frames is cut by
 * `cutFrames`, which never leaves untrusted text outside a frame. The full text goes to a
 * private file (a producer's own file is reused). `spill: false` (a reader that cannot open the
 * file) or a failed write keeps the same cut with a size-only notice. `reservedChars` is the text
 * a route adds when it serializes the bounded result (separators, placeholders for blocks it
 * cannot send), so that route's own cap never cuts a bounded result.
 */
export async function boundToolResult<T extends { content: unknown[]; details?: unknown }>(
  result: T,
  contextWindowTokens: number | undefined,
  spill?: PrivateTempFileOptions | false,
  reservedChars = 0,
): Promise<T> {
  const budget = resolveToolResultBudget(contextWindowTokens) ?? {
    maxChars: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    maxContextChars: Infinity,
  };
  budget.maxChars = Math.max(0, budget.maxChars - reservedChars);
  // Fit is judged on the result as sent; only a result that does not fit is cut.
  if (
    truncateToolResultMessage(result, budget.maxChars) === result &&
    contextChars(result.content) <= budget.maxContextChars
  ) {
    return result;
  }
  const nonText = contextChars(result.content.filter((block) => !isToolResultTextBlock(block)));
  const framed = result.content.some(
    (block) => isToolResultTextBlock(block) && findExternalContentFrames(block.text).length > 0,
  );
  // One text block keeps head and tail at every budget; several blocks keep the truncator's
  // short-record rules.
  const minKeepChars =
    result.content.filter((block) => isToolResultTextBlock(block)).length === 1 ? 0 : undefined;
  const cut = (suffix: (omittedChars: number) => string = formatOmittedCharsNotice) => {
    if (framed) {
      return cutFrames(result, budget, nonText, suffix);
    }
    const loose = truncateToolResultMessage(result, budget.maxChars, { suffix, minKeepChars });
    // Images that cannot fit at all stay with the context guard, which drops them.
    return contextChars(loose.content) <= budget.maxContextChars ||
      nonText >= budget.maxContextChars
      ? loose
      : truncateToolResultMessage(
          result,
          Math.min(budget.maxChars, budget.maxContextChars - nonText),
          { suffix, minKeepChars, minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE },
        );
  };
  const sizeOnly = cut();
  if (sizeOnly === result) {
    return result;
  }
  const producerSpill = getToolResultSpillDetails(result);
  const fullText = result.content
    .flatMap((block) => (isToolResultTextBlock(block) ? [block.text] : []))
    .join("\n");
  // A reader that cannot open Gateway files gets no path, not even a producer's own file.
  let path = spill === false ? undefined : producerSpill?.path;
  if (!path && spill !== false) {
    try {
      path = await writePrivateTempFile("openclaw-tool-result", fullText, spill);
    } catch (error) {
      log.warn(`[tool-result-bounds] spill write failed: ${formatErrorMessage(error)}`);
    }
  }
  if (!path) {
    return sizeOnly;
  }
  const footer = formatFullOutputFooter(path);
  const bounded = cut(
    (omitted) => `[... ${Math.max(1, Math.floor(omitted))} chars omitted. ${footer}]`,
  );
  // A budget too small for the whole path would name a cut path; say only the size.
  if (
    !bounded.content.some(
      (block) => isToolResultTextBlock(block) && block.text.includes(`${footer}]`),
    )
  ) {
    return sizeOnly;
  }
  const details = bounded.details ?? {};
  if (producerSpill || !isRecord(details)) {
    return bounded;
  }
  return { ...bounded, details: { ...details, spill: { path, chars: fullText.length } } };
}
