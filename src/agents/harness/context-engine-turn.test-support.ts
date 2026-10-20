import { vi } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import type { TranscriptTurnBoundary } from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "./context-engine-turn-attempt.js";

export function createTurnBoundary(
  storePath: string,
  logicalTurnId: string,
  sessionId = "session-a",
  sequence = 1,
): TranscriptTurnBoundary {
  const anchor = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
    generation: "generation-1",
    entryId: `${logicalTurnId}:user`,
    rawSeq: sequence,
    activeMessagePosition: sequence,
    effectiveParentId: null,
  };
  return {
    admission: { ...anchor, logicalTurnId, role: "user" },
    terminal: {
      ...anchor,
      entryId: `${logicalTurnId}:assistant`,
      rawSeq: sequence + 1,
      activeMessagePosition: sequence + 1,
      effectiveParentId: anchor.entryId,
    },
  };
}

export const appendTurnMessage = (
  target: Parameters<typeof appendTranscriptMessage>[0],
  role: "user" | "assistant",
  content: string,
  now: number,
  parentId?: string,
) => appendTranscriptMessage(target, { message: { role, content }, now, parentId });

export const createTurnFacts = (
  boundary: TranscriptTurnBoundary,
  sessionTarget?: ContextEngineTurnAttemptFacts["sessionTarget"],
): ContextEngineTurnAttemptFacts => ({
  boundary,
  sessionTarget,
  sessionIdUsed: boundary.admission.sessionId,
  sessionKey: boundary.admission.sessionKey,
  promptError: false,
  aborted: false,
  yieldAborted: false,
});

export function createTurnEngine<T extends NonNullable<ContextEngine["commitTurn"]>>(
  commitTurn: T,
  durable = true,
) {
  return {
    info: {
      id: "test",
      name: "Test",
      transcriptSemantics: durable
        ? {
            currentTurnFence: "before-current-turn-entry-v1" as const,
            turnAdvancementIdempotency: "atomic-idempotent-v1" as const,
          }
        : undefined,
    },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    commitTurn,
  } satisfies ContextEngine;
}

export const createTurnLease = (engine: ContextEngine) =>
  ({
    engine,
    effectiveEngine: engine,
    effectiveEngineId: "test",
    degraded: false,
    disposed: false,
    selectForHost: vi.fn(),
    degradeBeforeStart: vi.fn(),
    begin: vi.fn(),
    onDispose: vi.fn(),
    deferDisposalUntil: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }) satisfies ContextEngineLogicalTurnLease;
