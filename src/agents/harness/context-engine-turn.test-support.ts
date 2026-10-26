import { vi } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import type { TranscriptTurnBoundary } from "../../config/sessions/transcript-entry-anchor.js";
import { createPassthroughEngineMethods } from "../../context-engine/context-engine.test-support.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { finalizeHarnessContextEngineTurn } from "./context-engine-lifecycle.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "./context-engine-turn-attempt.js";

export function createTurnTarget(storePath: string, sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}

export const createCommitTurn = () =>
  vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({ status: "committed" }));

type FinalizeParams = Parameters<typeof finalizeHarnessContextEngineTurn>[0];
const successFlags = { promptError: false, aborted: false, yieldAborted: false };
export function finalizeTurn(
  params: Pick<FinalizeParams, "sessionFile" | "sessionIdUsed"> & Partial<FinalizeParams>,
) {
  return finalizeHarnessContextEngineTurn({
    messagesSnapshot: [],
    prePromptMessageCount: 0,
    ...successFlags,
    warn: vi.fn(),
    ...params,
  });
}

export function createTurnBoundary(
  storePath: string,
  logicalTurnId: string,
  sessionId = "session-a",
  sequence = 1,
): TranscriptTurnBoundary {
  const anchor = (role: "user" | "assistant", rawSeq: number) => ({
    ...createTurnTarget(storePath, sessionId),
    generation: "generation-1",
    entryId: `${logicalTurnId}:${role}`,
    rawSeq,
    activeMessagePosition: rawSeq,
    effectiveParentId: role === "user" ? null : `${logicalTurnId}:user`,
  });
  return {
    admission: { ...anchor("user", sequence), logicalTurnId, role: "user" },
    terminal: anchor("assistant", sequence + 1),
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
  ...successFlags,
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
