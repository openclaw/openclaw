import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexHistoryRejection } from "./history-rejection.js";
import type { JsonValue } from "./protocol.js";
import { projectSettledCodexMessages, SettledTurnPriorContext } from "./settled-turn-projection.js";
import { serializeCodexMirrorSourceEvidence } from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

export type SettledTurnMessages = {
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
  /** The run's persisted prompt when a continuation started a later native turn. */
  promptIdentity?: string;
  /** The run mirrored no prompt for this turn: an internal system turn without a recorder. */
  promptSuppressed?: boolean;
};

function rejectEvidence(): never {
  throw new CodexHistoryRejection("provenance_rejected");
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
  const hasPrompt = requiredIds.includes(promptIdentity);
  if (
    !boundaryIdentity?.startsWith(`${params.turnId}:tool:`) ||
    requiredIds.length !== boundaryIndex + 1 ||
    new Set(requiredIds).size !== requiredIds.length ||
    (params.promptSuppressed
      ? hasPrompt || !anchorIdentity?.startsWith(`${params.turnId}:`)
      : !hasPrompt)
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
    currentStarted ||= identity === anchorIdentity;
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
