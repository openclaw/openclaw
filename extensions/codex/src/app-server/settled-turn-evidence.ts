import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexHistoryRejection, type CodexHistoryRejectionReason } from "./history-rejection.js";
import type { JsonValue } from "./protocol.js";
import { projectSettledCodexMessages, SettledTurnPriorContext } from "./settled-turn-projection.js";
import { serializeCodexMirrorSourceEvidence } from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

export type SettledTurnMessages = {
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
  /** The run's persisted prompt when a same-run continuation started a later native turn. */
  promptIdentity?: string;
  /** The run mirrored no prompt for this turn: an internal system turn without a recorder. */
  promptSuppressed?: boolean;
};

function rejectEvidence(reason: CodexHistoryRejectionReason): never {
  throw new CodexHistoryRejection(reason);
}

/** The worker consumes this verifier lazily; rejection never acquires the remaining payloads. */
export function projectVerifiedSettledCodexMessages(
  history: Iterable<AgentMessage>,
  params: SettledTurnMessages,
): JsonValue[] {
  // Omitted history still participates in call-ID uniqueness for the complete prefix.
  const seenCallIds = new Set<string>();
  const prior = new SettledTurnPriorContext(seenCallIds);
  const current = projectSettledCodexMessages(
    verifiedSettledMessages(history, params, prior),
    seenCallIds,
  );
  return prior.prependTo(current);
}

/** Yields only the settled prefix, but exhausts suffix identity checks before accepting it. */
function* verifiedSettledMessages(
  history: Iterable<AgentMessage>,
  params: SettledTurnMessages,
  prior: SettledTurnPriorContext,
): Generator<AgentMessage> {
  const promptIdentity = params.promptIdentity ?? `${params.turnId}:prompt`;
  const boundaryIndex = params.settledMessages.findLastIndex(
    (message) => message.role === "toolResult",
  );
  const boundary = params.settledMessages[boundaryIndex];
  const boundaryIdentity = boundary && readMirrorIdentity(boundary);
  const requiredIds = params.settledMessages
    .slice(0, boundaryIndex + 1)
    .flatMap((message) => readMirrorIdentity(message) ?? []);
  // A turn without a mirrored prompt starts at its first mirrored row; the user turn
  // that produced it is then prior context, never borrowed as this turn's prompt.
  const anchorIdentity = params.promptSuppressed ? requiredIds[0] : promptIdentity;
  if (!boundaryIdentity?.startsWith(`${params.turnId}:tool:`)) {
    rejectEvidence("provenance_missing_boundary");
  }
  if (requiredIds.length !== boundaryIndex + 1) {
    rejectEvidence("provenance_unattested_prefix");
  }
  if (new Set(requiredIds).size !== requiredIds.length) {
    rejectEvidence("provenance_duplicate_identity");
  }
  if (params.promptSuppressed) {
    if (requiredIds.includes(promptIdentity)) {
      rejectEvidence("provenance_unexpected_prompt");
    }
    if (!anchorIdentity?.startsWith(`${params.turnId}:`)) {
      rejectEvidence("provenance_foreign_anchor");
    }
  } else if (!requiredIds.includes(promptIdentity)) {
    rejectEvidence("provenance_missing_prompt");
  }
  const mirrored = params.mirroredMessages;
  const mirroredIds = mirrored.flatMap((message) => readMirrorIdentity(message) ?? []);
  const mirroredBoundaryIndex = mirrored.findIndex(
    (message) => readMirrorIdentity(message) === boundaryIdentity,
  );
  if (new Set(mirroredIds).size !== mirroredIds.length) {
    rejectEvidence("provenance_duplicate_identity");
  }
  if (
    mirroredBoundaryIndex + 1 !== requiredIds.length ||
    requiredIds.some((id, index) => readMirrorIdentity(mirrored[index]!) !== id)
  ) {
    rejectEvidence("provenance_mirror_prefix");
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
        rejectEvidence("provenance_duplicate_identity");
      }
      seen.add(identity);
      const expected = required.get(identity);
      if (expected) {
        if (identity !== requiredIds[matched]) {
          rejectEvidence("provenance_history_order");
        }
        if (
          serializeCodexMirrorSourceEvidence(message) !==
          serializeCodexMirrorSourceEvidence(expected)
        ) {
          rejectEvidence("provenance_fingerprint_drift");
        }
        matched += 1;
      }
    }
    currentStarted ||= identity === anchorIdentity;
    if (!currentStarted) {
      prior.append(message);
    } else if (!throughBoundary) {
      yield message;
    }
    throughBoundary ||= identity === boundaryIdentity;
  }
  if (!throughBoundary || matched !== requiredIds.length) {
    rejectEvidence("provenance_history_incomplete");
  }
}
