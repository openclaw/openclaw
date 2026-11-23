import { expectDefined } from "@openclaw/normalization-core/expect";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { truncateUtf16WithEllipsis } from "../../../shared/text-truncate.js";
import { renderRuntimeCoordinationFailureCopy } from "../../failover/assistant-request-failure-copy.js";
import { hasPrivateRequesterInput } from "../registry/subagent-delivery-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

const MAX_NOTICE_CHARS = 32_000;
const MAX_RESULT_CHARS = 2_000;
const TRUNCATED_RESULT = "\n[result truncated; see full-result recovery below]";
const RECOVERY =
  "Full-result recovery: use Gateway chat.history with the child's sessionKey and maxChars=500000; page with offset to locate this run's final message. Then use chat.message.get with its messageId and sessionId, and maxChars=8000000, for the retained full text. Existing session access and retention limits apply. sessions_history alone truncates text fields to 4,000 characters.";

/** Bound failure context without changing captured results or normal result delivery. */
export function buildSubagentCompletionFailureNotice(
  batch: readonly SubagentRunRecord[],
  kind: "failed" | "delayed",
): string {
  const heading =
    kind === "delayed"
      ? "Automatic delivery of a child result timed out. The result is still saved and may still arrive automatically."
      : expectDefined(
          renderRuntimeCoordinationFailureCopy("child_completion_delivery_failed"),
          "child completion failure notice",
        );
  const sorted = batch.toSorted((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const overflow = (count: number) =>
    `[${count} additional child results omitted; list the requester's children with the available session tools and read their history.]`;
  // Reserve framing, recovery guidance and the overflow count before allocating result heads.
  let remaining =
    MAX_NOTICE_CHARS - heading.length - RECOVERY.length - overflow(batch.length).length - 6;
  const perChild = Math.max(768, Math.floor(remaining / Math.max(1, sorted.length)));
  const sections: string[] = [];
  let truncated = false;
  for (const child of sorted) {
    const outcome = child.execution.outcome;
    const status =
      outcome?.status === "error"
        ? outcome.error === "Gateway stopped"
          ? "Interrupted by Gateway restart; not resumed."
          : outcome.error
        : outcome?.status;
    const identity = `Child ${child.childSessionKey} (run ${child.runId})\n${status ?? "unknown"}`;
    const header = truncateUtf16WithEllipsis(identity, 512);
    const captured = hasPrivateRequesterInput(child)
      ? ""
      : (resolveSubagentCompletionResultText(child) ?? "");
    const resultLimit = Math.min(MAX_RESULT_CHARS, perChild - header.length - 4);
    const result =
      captured.length > resultLimit
        ? `${truncateUtf16Safe(captured, resultLimit - TRUNCATED_RESULT.length)}${TRUNCATED_RESULT}`
        : captured;
    const section = captured ? `${header}\n\n${result}` : header;
    if (section.length + 2 > remaining) {
      break;
    }
    sections.push(section);
    remaining -= section.length + 2;
    truncated ||= result !== captured || header !== identity;
  }
  if (sections.length < sorted.length) {
    sections.push(overflow(sorted.length - sections.length));
    truncated = true;
  }
  return [heading, ...sections, ...(truncated ? [RECOVERY] : [])].join("\n\n");
}
