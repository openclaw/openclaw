/** Agent-run result projections shared by execution owners and diagnostic probes. */
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "./agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/** Only the transcript owner's receipt makes a final CLI reply durable. */
export function hasCommittedCliFinalReply(result: EmbeddedAgentRunResult): boolean {
  return (
    result.meta.executionTrace?.runner === "cli" &&
    result.meta.completion?.finishReason === "stop" &&
    !result.meta.error &&
    result.payloads?.some((payload) => {
      const metadata = getReplyPayloadMetadata(payload);
      return (
        metadata?.assistantTranscriptOwned === true &&
        Boolean(metadata.assistantTranscriptIdempotencyKey)
      );
    }) === true
  );
}

/** Adds an owner-bounded, redacted diagnostic without discarding returned work. */
export function appendAgentRunFailure(
  result: EmbeddedAgentRunResult,
  diagnostic: string,
): EmbeddedAgentRunResult {
  const primaryError = result.meta.error;
  // Preserve interruptions and delivery evidence. A replacement also owns a fresh
  // fallback classification rather than mutating an already-classified result.
  return {
    ...result,
    payloads: [...(result.payloads ?? []), { text: diagnostic, isError: true }],
    meta: {
      ...result.meta,
      replayInvalid: true,
      error: {
        ...primaryError,
        kind: primaryError?.kind ?? "incomplete_turn",
        message: primaryError ? `${primaryError.message}\n${diagnostic}` : diagnostic,
        // Incomplete-turn fallbackSafe otherwise overrides replayInvalid.
        fallbackSafe: false,
      },
    },
  };
}

export type AgentRunResultView = {
  payloads?: Array<ReplyPayload & { visible?: boolean }>;
  meta?: {
    terminalReply?: EmbeddedAgentRunResult["meta"]["terminalReply"];
    aborted?: boolean;
    stopReason?: string;
    timeoutPhase?: EmbeddedAgentRunResult["meta"]["timeoutPhase"];
    providerStarted?: boolean;
    executionTrace?: { winnerProvider?: string; winnerModel?: string };
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    livenessState?: string;
    error?: { kind?: string; message?: string };
  };
};

export function extractAgentRunText(result: AgentRunResultView): string | undefined {
  if (result.meta?.terminalReply?.disposition === "silent") {
    return undefined;
  }
  const visibleText = result.meta?.finalAssistantVisibleText;
  if (visibleText?.trim()) {
    return visibleText;
  }
  return (
    result.payloads
      ?.filter(
        (payload) =>
          payload.visible !== false &&
          payload.isError !== true &&
          isReplyPayloadTerminalContent(payload),
      )
      .map((payload) => payload.text)
      .filter((text): text is string => Boolean(text?.trim()))
      .join("\n") || undefined
  );
}

export function extractAgentRunTerminalError(result: AgentRunResultView): string | undefined {
  const errorPayload = result.payloads?.find((payload) => payload.isError === true)?.text?.trim();
  const error = result.meta?.error?.message?.trim() || errorPayload;
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: errorPayload || result.meta?.error ? "error" : "end",
    data: { ...result.meta, error },
  });
  if (outcome.status === "ok") {
    return undefined;
  }
  return (
    error ||
    outcome.error ||
    (outcome.status === "timeout" ? "Inference timed out." : `Inference ${outcome.reason}.`)
  );
}
