import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { splitExternalContentEnvelope } from "../../security/external-content.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  writePrivateTempFile,
  type PrivateTempFileOptions,
} from "../sessions/tools/private-temp-file.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  resolveToolResultBudget,
} from "../tool-result-limits.js";
import { log } from "./logger.js";
import {
  estimateMessageChars,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
} from "./tool-result-char-estimator.js";
import { estimateToolResultTextChars, isToolResultTextBlock } from "./tool-result-text-budget.js";
import {
  getToolResultSpillDetails,
  truncateToolResultMessage,
  type ToolResultTruncationOptions,
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

const withText = <T extends { content: unknown[] }>(result: T, index: number, text: string): T => ({
  ...result,
  content: result.content.map((block, i) =>
    i === index && isToolResultTextBlock(block) ? { ...block, text } : block,
  ),
});

const textAt = (content: unknown[], index: number) => {
  const block = content[index];
  return isToolResultTextBlock(block) ? block : undefined;
};

/** The one text block, when it is exactly one untrusted-content envelope. */
function findEnvelope(content: unknown[]) {
  const texts = content.flatMap((block, index) => (isToolResultTextBlock(block) ? [index] : []));
  const index = texts.length === 1 ? texts[0]! : -1;
  const block = textAt(content, index);
  // A block that mirrors its text in `content` would keep the unwrapped copy there.
  const parts =
    block && typeof Reflect.get(block, "content") !== "string"
      ? splitExternalContentEnvelope(block.text)
      : undefined;
  return parts && { index, ...parts };
}

/**
 * Bounds a fresh tool result once, before its first send, on every route. The budget is the
 * strictest one the result meets later: the per-result cap and the context guard's weighted
 * share (images and other blocks reserved first), so neither re-cuts a bounded result.
 * Head and tail are kept; an untrusted-content envelope whose frame fits keeps its warning and
 * both markers whole and only its body is cut. The full text goes to a private file (a producer's own file
 * is reused). `spill: false` (a reader that cannot open the file) or a failed write keeps the
 * same cut with a size-only notice.
 */
export async function boundToolResult<T extends { content: unknown[]; details?: unknown }>(
  result: T,
  contextWindowTokens: number | undefined,
  spill?: PrivateTempFileOptions | false,
): Promise<T> {
  const budget = resolveToolResultBudget(contextWindowTokens) ?? {
    maxChars: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    maxContextChars: Infinity,
  };
  // Fit is judged on the result as sent; only a result that does not fit is cut.
  if (
    truncateToolResultMessage(result, budget.maxChars) === result &&
    contextChars(result.content) <= budget.maxContextChars
  ) {
    return result;
  }
  const found = findEnvelope(result.content);
  const frame = found ? `${found.open}${found.close}` : "";
  const frameChars = estimateToolResultTextChars(frame);
  const frameContext = found ? contextChars([{ type: "text", text: frame }]) : 0;
  const nonText = contextChars(result.content.filter((block) => !isToolResultTextBlock(block)));
  // A frame that does not fit beside the other blocks (hostile metadata, or an image that
  // takes the share) is cut as plain text instead.
  const envelope =
    found && frameChars < budget.maxChars && nonText + frameContext < budget.maxContextChars
      ? found
      : undefined;
  const source = envelope ? withText(result, envelope.index, envelope.body) : result;
  const maxChars = envelope ? budget.maxChars - frameChars : budget.maxChars;
  const reserved = nonText + (envelope ? frameContext : 0);
  // One text block keeps head and tail at every budget (a whole-prefix cut loses the end, and
  // an end marker with it); several blocks keep the truncator's short-record rules.
  const minKeepChars =
    result.content.filter((block) => isToolResultTextBlock(block)).length === 1 ? 0 : undefined;
  const cut = (suffix?: ToolResultTruncationOptions["suffix"]) => {
    const loose = truncateToolResultMessage(source, maxChars, { suffix, minKeepChars });
    // Images that cannot fit at all stay with the context guard, which drops them.
    const inner =
      contextChars(loose.content) + (envelope ? frameContext : 0) <= budget.maxContextChars ||
      reserved >= budget.maxContextChars
        ? loose
        : truncateToolResultMessage(source, Math.min(maxChars, budget.maxContextChars - reserved), {
            suffix,
            minKeepChars,
            minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
          });
    if (inner === source) {
      return result;
    }
    if (!envelope) {
      return inner;
    }
    const body = textAt(inner.content, envelope.index)?.text ?? "";
    return withText(inner, envelope.index, `${envelope.open}${body}${envelope.close}`);
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
