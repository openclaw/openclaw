import { vi } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import type { TranscriptTurnBoundary } from "../../config/sessions/transcript-entry-anchor.js";
import { createPassthroughEngineMethods } from "../../context-engine/context-engine.test-support.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "./context-engine-turn-attempt.js";

export function createTurnBoundary(
  storePath: string,
  logicalTurnId: string,
  sessionId = "session-a",
  sequence = 1,
): TranscriptTurnBoundary {
  const anchor = (
    role: "user" | "assistant",
    rawSeq: number,
    effectiveParentId: string | null,
  ) => ({
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
    generation: "generation-1",
    entryId: `${logicalTurnId}:${role}`,
    rawSeq,
    activeMessagePosition: rawSeq,
    effectiveParentId,
  });
  return {
    admission: { ...anchor("user", sequence, null), logicalTurnId, role: "user" },
    terminal: anchor("assistant", sequence + 1, `${logicalTurnId}:user`),
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
  const info: ContextEngine["info"] = { id: "test", name: "Test" };
  if (durable) {
    info.transcriptSemantics = {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    };
  }
  return {
    info,
    ...createPassthroughEngineMethods(),
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
