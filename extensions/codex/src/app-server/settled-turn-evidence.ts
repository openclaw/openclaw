import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CodexHistoryRejection, codexHistoryRejectionReason } from "./history-rejection.js";
import type { JsonValue } from "./protocol.js";
import {
  projectSettledCodexMessages,
  SettledTurnPriorContext,
  validateSettledCodexMessages,
} from "./settled-turn-projection.js";
import { serializeCodexMirrorSourceEvidence } from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

export type SettledTurnMessages = {
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
  /** Permit bounded error evidence when the complete current turn exceeds replay limits. */
  toolFailureExplanation?: boolean;
};

function rejectEvidence(): never {
  throw new CodexHistoryRejection("provenance_rejected");
}

/** Verify transcript provenance before admitting replay or bounded error evidence. */
export function projectVerifiedSettledCodexMessages(
  history: Iterable<AgentMessage>,
  params: SettledTurnMessages,
): JsonValue[] {
  // Omitted history still participates in call-ID uniqueness for the complete prefix.
  const seenCallIds = new Set<string>();
  const prior = new SettledTurnPriorContext(seenCallIds);
  if (params.toolFailureExplanation) {
    // Exhaust attestation before selecting evidence. A size limit cannot hide a
    // mismatched late transcript row or an invalid call/result exchange.
    const messages = Array.from(verifiedSettledMessages(history, params, prior));
    try {
      return prior.prependTo(projectSettledCodexMessages(messages, new Set(seenCallIds)));
    } catch (error) {
      if (
        !["item_limit", "byte_limit", "field_limit"].includes(codexHistoryRejectionReason(error))
      ) {
        throw error;
      }
      validateSettledCodexMessages(messages, new Set(seenCallIds));
      prior.prependTo([]);
      return projectToolFailureEvidence(messages);
    }
  }
  const current = projectSettledCodexMessages(
    verifiedSettledMessages(history, params, prior),
    seenCallIds,
  );
  return prior.prependTo(current);
}

function projectToolFailureEvidence(messages: readonly AgentMessage[]): JsonValue[] {
  const failedIndex = messages.findLastIndex(
    (message) => message.role === "toolResult" && message.isError && !isMissingToolResult(message),
  );
  const failed = messages[failedIndex];
  const request = messages.find((message) => message.role === "user");
  if (failed?.role !== "toolResult" || !request) {
    throw new CodexHistoryRejection("incomplete_pairing");
  }
  const laterResult = messages
    .slice(failedIndex + 1)
    .findLast(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === failed.toolName &&
        !message.isError &&
        !isMissingToolResult(message),
    );
  const selectedResults = laterResult ? [failed, laterResult] : [failed];
  const selectedIds = new Set(
    selectedResults.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : [],
    ),
  );
  const evidence: AgentMessage[] = [request];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.filter((part) => {
        if (!isRecord(part) || part.type !== "toolCall") {
          return false;
        }
        const id = part.id ?? part.toolCallId;
        return typeof id === "string" && selectedIds.has(id);
      });
      if (content.length) {
        evidence.push({ ...message, content });
      }
    } else if (message.role === "toolResult" && selectedIds.has(message.toolCallId)) {
      evidence.push(message);
    }
  }
  evidence.push({
    role: "user",
    content:
      "[This bounded error explanation includes the original request, the latest recorded tool failure, " +
      "and the most recent later successful result for that tool when available. Other work from the " +
      "current turn and earlier conversation was omitted. Explain the actual retained error. " +
      "A later success proves recovery only if its arguments and result address that same failure. " +
      "Do not infer that omitted work failed, succeeded, or remains unfinished. Calls without a recorded " +
      "result have unknown outcomes. Do not claim the overall task completed or repeat any actions.]",
    timestamp: 0,
  });
  return projectSettledCodexMessages(evidence);
}

function isMissingToolResult(message: AgentMessage): boolean {
  return (
    message.role === "toolResult" &&
    isRecord(message.details) &&
    message.details.reason === "missing_tool_result"
  );
}

/** Yields only the settled prefix, but exhausts suffix identity checks before accepting it. */
function* verifiedSettledMessages(
  history: Iterable<AgentMessage>,
  params: SettledTurnMessages,
  prior: SettledTurnPriorContext,
): Generator<AgentMessage> {
  const promptIdentity = `${params.turnId}:prompt`;
  const boundaryIndex = params.settledMessages.findLastIndex(
    (message) => message.role === "toolResult",
  );
  const boundary = params.settledMessages[boundaryIndex];
  const boundaryIdentity = boundary && readMirrorIdentity(boundary);
  const requiredIds = params.settledMessages
    .slice(0, boundaryIndex + 1)
    .flatMap((message) => readMirrorIdentity(message) ?? []);
  if (
    !boundaryIdentity?.startsWith(`${params.turnId}:tool:`) ||
    requiredIds.length !== boundaryIndex + 1 ||
    new Set(requiredIds).size !== requiredIds.length ||
    !requiredIds.includes(promptIdentity)
  ) {
    rejectEvidence();
  }
  const mirrored = params.mirroredMessages;
  const mirroredIds = mirrored.flatMap((message) => readMirrorIdentity(message) ?? []);
  const mirroredBoundaryIndex = mirrored.findIndex(
    (message) => readMirrorIdentity(message) === boundaryIdentity,
  );
  if (
    new Set(mirroredIds).size !== mirroredIds.length ||
    mirroredBoundaryIndex + 1 !== requiredIds.length ||
    requiredIds.some((id, index) => readMirrorIdentity(mirrored[index]!) !== id)
  ) {
    rejectEvidence();
  }
  const required = new Map(requiredIds.map((id, index) => [id, mirrored[index]!]));
  const seen = new Set<string>();
  let matched = 0;
  let throughBoundary = false;
  let currentStarted = false;
  for (const message of history) {
    const identity = readMirrorIdentity(message);
    if (identity) {
      if (seen.has(identity)) {
        rejectEvidence();
      }
      seen.add(identity);
      const expected = required.get(identity);
      if (expected) {
        if (
          identity !== requiredIds[matched] ||
          serializeCodexMirrorSourceEvidence(message) !==
            serializeCodexMirrorSourceEvidence(expected)
        ) {
          rejectEvidence();
        }
        matched += 1;
      }
    }
    currentStarted ||= identity === promptIdentity;
    if (!currentStarted) {
      prior.append(message);
    } else if (!throughBoundary) {
      yield message;
    }
    throughBoundary ||= identity === boundaryIdentity;
  }
  if (!throughBoundary || matched !== requiredIds.length) {
    rejectEvidence();
  }
}
