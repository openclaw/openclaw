import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  writePrivateTempFile,
  type PrivateTempFileOptions,
} from "../sessions/tools/private-temp-file.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import { log } from "./logger.js";
import { isToolResultTextBlock } from "./tool-result-text-budget.js";
import { getToolResultSpillDetails, truncateToolResultMessage } from "./tool-result-truncation.js";

/**
 * Bounds a fresh tool result once, before its first send. The full text goes to a
 * private file the model can page with `read`; a producer's own file is reused.
 * A failed write returns the result unchanged, so the transcript cap bounds it.
 */
export async function boundToolResult<T extends { content: unknown[]; details?: unknown }>(
  result: T,
  maxChars: number,
  spill?: PrivateTempFileOptions,
): Promise<T> {
  if (truncateToolResultMessage(result, maxChars) === result) {
    return result;
  }
  const producerSpill = getToolResultSpillDetails(result);
  const fullText = result.content
    .flatMap((block) => (isToolResultTextBlock(block) ? [block.text] : []))
    .join("\n");
  let path = producerSpill?.path;
  if (!path) {
    try {
      path = await writePrivateTempFile("openclaw-tool-result", fullText, spill);
    } catch (error) {
      log.warn(`[tool-result-bounds] spill write failed: ${formatErrorMessage(error)}`);
      return result;
    }
  }
  const footer = formatFullOutputFooter(path);
  const bounded = truncateToolResultMessage(result, maxChars, {
    suffix: (omitted) =>
      `[... ${Math.max(1, Math.floor(omitted))} chars omitted. ${footer} (page it with read offset/limit)]`,
  });
  const details = bounded.details ?? {};
  if (producerSpill || !isRecord(details)) {
    return bounded;
  }
  return { ...bounded, details: { ...details, spill: { path, chars: fullText.length } } };
}
