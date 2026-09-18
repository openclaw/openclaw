/** The details a generated compaction boundary persists, and the run-owned request it carries. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { getCompactionContent } from "./utils.js";

const MAX_LATEST_USER_REQUEST_CHARS = 800;
const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... latest user request truncated ...]\n";

export function extractLatestUserRequest(messages: AgentMessage[]): string | undefined {
  let source = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      source = getCompactionContent(message.content).text.trim();
      if (source) {
        break;
      }
    }
  }
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
  /** Files read in the compacted history. */
  readFiles: string[];
  /** Files modified in the compacted history. */
  modifiedFiles: string[];
  /** Run-owned request that remains active across another compaction generation. */
  latestUnresolvedUserRequest?: string;
  /**
   * Set when the summary is the safeguard's structured fallback rather than a
   * generated summary, because quality validation was exhausted. Recorded here so
   * "was this boundary degraded?" is answered by the boundary, not inferred from
   * the fallback template's prose.
   */
  qualityDegraded?: true;
}

export function parseCompactionDetails(value: unknown): CompactionDetails | undefined {
  const details = asOptionalRecord(value);
  if (
    !details ||
    !Array.isArray(details.readFiles) ||
    !details.readFiles.every((file): file is string => typeof file === "string") ||
    !Array.isArray(details.modifiedFiles) ||
    !details.modifiedFiles.every((file): file is string => typeof file === "string")
  ) {
    return undefined;
  }
  const request = details.latestUnresolvedUserRequest;
  const latestUnresolvedUserRequest =
    typeof request === "string" && request.length <= MAX_LATEST_USER_REQUEST_CHARS
      ? request
      : undefined;
  return {
    readFiles: details.readFiles,
    modifiedFiles: details.modifiedFiles,
    ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    ...(details.qualityDegraded === true ? { qualityDegraded: true as const } : {}),
  };
}
