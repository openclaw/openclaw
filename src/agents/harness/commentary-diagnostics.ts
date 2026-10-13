import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticHarnessRunStartedEvent,
} from "../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { isCompleteAgentPreamble } from "../agent-activity-presentation.js";

const MAX_COMMENTARY_CHARS = 16_384;
const MAX_RECENT_COMMENTARY = 256;

/** Observe accepted, completed preambles for one harness attempt. */
export function subscribeAgentCommentaryDiagnostics(
  config: unknown,
  base: Omit<DiagnosticHarnessRunStartedEvent, "type" | "seq" | "ts">,
): () => void {
  const capture = resolveDiagnosticModelContentCapturePolicy(config).outputMessages;
  const recent = new Set<string>();
  return onAgentEventForRun(base.runId, (evt) => {
    if (
      !areDiagnosticsEnabledForProcess() ||
      evt.stream !== "item" ||
      evt.data.kind !== "preamble"
    ) {
      return;
    }
    const text = typeof evt.data.progressText === "string" ? evt.data.progressText.trim() : "";
    const phase = typeof evt.data.phase === "string" ? evt.data.phase : undefined;
    if (!text || !isCompleteAgentPreamble({ phase, progressText: text })) {
      return;
    }
    const itemId = typeof evt.data.itemId === "string" ? evt.data.itemId : "";
    // Replay may repeat a completed item. Keep only bounded hashes, never raw
    // commentary in dedupe state when content capture is disabled.
    const signature = createHash("sha256").update(itemId).update("\0").update(text).digest("hex");
    if (recent.has(signature)) {
      return;
    }
    recent.add(signature);
    if (recent.size > MAX_RECENT_COMMENTARY) {
      recent.delete(recent.values().next().value!);
    }
    const event = {
      ...base,
      type: "agent.commentary" as const,
      sourceSequence: evt.seq,
      sourceTimestampMs: evt.ts,
      ...(itemId ? { itemId: truncateUtf16Safe(itemId, 512) } : {}),
      textLength: text.length,
      contentCaptured: capture,
      contentTruncated: capture && text.length > MAX_COMMENTARY_CHARS,
    };
    // Capture the harness trace at registration: warm transport callbacks may
    // arrive outside its async scope. Gate and bound private text before enqueue.
    emitTrustedDiagnosticEventWithPrivateData(
      event,
      capture
        ? {
            modelContent: {
              outputMessages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: truncateUtf16Safe(text, MAX_COMMENTARY_CHARS) }],
                },
              ],
            },
          }
        : undefined,
    );
    runWithDiagnosticTraceContext(base.trace, () =>
      diagnosticLogger.debug("agent commentary completed", {
        runId: base.runId,
        harnessId: base.harnessId,
        sourceSequence: evt.seq,
        textLength: text.length,
      }),
    );
  });
}
