import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  acceptCompactionSuccessor,
  type AcceptedCompactionSuccessor,
} from "./compaction-successor.js";

const edge = vi.hoisted(() => ({
  forbidden: vi.fn((): never => {
    throw new Error(
      "Pure compaction lifetime proof crossed a native or unrelated runtime boundary",
    );
  }),
  load: vi.fn<typeof import("../../config/sessions/session-accessor.js").loadSessionEntry>(),
  patch: vi.fn<typeof import("../../config/sessions/session-accessor.js").patchSessionEntryCore>(),
  retire: vi.fn<typeof import("../agent-bundle-mcp-manager-api.js").retireSessionMcpRuntime>(),
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  end: vi.fn<HookRunner["runSessionEnd"]>(),
  start: vi.fn<HookRunner["runSessionStart"]>(),
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", () => ({
  Worker: edge.forbidden,
  MessageChannel: edge.forbidden,
  receiveMessageOnPort: edge.forbidden,
}));
vi.mock("node:child_process", () => ({
  spawn: edge.forbidden,
  spawnSync: edge.forbidden,
  exec: edge.forbidden,
  execSync: edge.forbidden,
  execFile: edge.forbidden,
  execFileSync: edge.forbidden,
  fork: edge.forbidden,
}));
vi.mock("../../infra/node-sqlite.js", () => ({
  requireNodeSqlite: edge.forbidden,
  openNodeSqliteDatabase: edge.forbidden,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../globals.js", () => ({ logVerbose: vi.fn() }));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: edge.load,
  patchSessionEntryCore: edge.patch,
  loadSessionEntryReadOnly: edge.forbidden,
  listSessionEntriesReadOnly: edge.forbidden,
}));
vi.mock("../../config/sessions/session-store-path.js", () => ({
  resolveSessionStorePathForScope: (scope: { storePath: string }) => scope.storePath,
}));
vi.mock("../../config/sessions/transcript-write-context.js", () => ({
  SessionTranscriptWriterClaimReboundError: class extends Error {},
}));
vi.mock("../../gateway/session-transcript-files.fs.js", () => ({
  resolveStableSessionEndTranscript: () => ({}),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: edge.hasHooks,
    runSessionEnd: edge.end,
    runSessionStart: edge.start,
  }),
}));
vi.mock("../agent-bundle-mcp-manager-api.js", () => ({ retireSessionMcpRuntime: edge.retire }));
vi.mock("../run-session-target.js", () => ({ resolveAgentRunSessionTarget: edge.forbidden }));
vi.mock("../session-placement-admission.js", () => ({
  captureSessionPlacementCompactionSuccessorAssertion: () => () => {},
}));

const predecessorId = "00000000-0000-4000-8000-000000000001";
const successorId = "00000000-0000-4000-8000-000000000002";
const target = {
  agentId: "main",
  sessionKey: "agent:main:compaction-lifetime",
  sessionId: predecessorId,
  storePath: "/synthetic/compaction-lifetime/openclaw-agent.sqlite",
};

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.resetAllMocks();
  edge.hasHooks.mockImplementation((name) => name === "session_end" || name === "session_start");
  edge.retire.mockResolvedValue(true);
});

afterEach(() => {
  forgetActiveSessionForShutdown(predecessorId);
  forgetActiveSessionForShutdown(successorId);
  expect(edge.forbidden).not.toHaveBeenCalled();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  resetGatewayWorkAdmission();
});

it.each([false, true])(
  "preserves the accepted successor and both hook lifetimes (identity observer cancels caller=%s)",
  async (cancelAfterCommit) => {
    const caller = new AsyncWorkScope();
    const failure = new Error("Compaction caller cancelled after commit");
    const endGate = createDeferred();
    const startGate = createDeferred();
    const facts: AcceptedCompactionSuccessor[] = [];
    const observed: { fact?: AcceptedCompactionSuccessor; signal?: AbortSignal } = {};
    let row: InternalSessionEntry = {
      sessionId: predecessorId,
      lifecycleRevision: "synthetic-lifecycle",
      activeWriterRunId: "synthetic-writer",
      updatedAt: 1,
    };
    edge.load.mockImplementation(() => structuredClone(row));
    edge.patch.mockImplementation(async (scope, update, options = {}) => {
      expect(scope).toEqual(target);
      const previous = structuredClone(row);
      const patch = await update(structuredClone(row), { existingEntry: structuredClone(row) });
      if (!patch) {
        throw new Error("Expected a successor identity patch");
      }
      options.assertCommitAllowed?.();
      row = { ...row, ...patch };
      try {
        options.onCommitted?.(structuredClone(row));
      } finally {
        // The entry owner publishes identity only after the committed-fact callback.
        emitSessionIdentityMutation({
          agentId: target.agentId,
          kind: "replace",
          previous: { sessionId: previous.sessionId, sessionKeys: [target.sessionKey] },
          current: { sessionId: row.sessionId, sessionKeys: [target.sessionKey] },
        });
      }
      return structuredClone(row);
    });
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (mutation.kind !== "replace" || mutation.previous.sessionId !== predecessorId) {
        return;
      }
      observed.fact = facts[0];
      observed.signal = getAsyncWorkSignal();
      if (cancelAfterCommit) {
        caller.beginClose(failure);
      }
    });
    const hookSignals: Array<AbortSignal | undefined> = [];
    edge.end.mockImplementation(async () => {
      hookSignals.push(getAsyncWorkSignal());
      await endGate.promise;
    });
    edge.start.mockImplementation(async () => {
      hookSignals.push(getAsyncWorkSignal());
      await startGate.promise;
    });
    noteActiveSessionForShutdown({ ...target, cfg: {} });
    try {
      const accepted = await caller.track(() =>
        acceptCompactionSuccessor({
          currentTarget: target,
          expectedEntry: {
            sessionId: row.sessionId,
            lifecycleRevision: row.lifecycleRevision,
            activeWriterRunId: row.activeWriterRunId,
          },
          assertActive: () => caller.signal.throwIfAborted(),
          config: {},
          result: {
            ok: true,
            compacted: true,
            result: { tokensBefore: 4_097, tokensAfter: 3_000, sessionId: successorId },
          },
          onCommitted: (fact) => facts.push(fact),
        }),
      );
      expect(observed.fact).toBe(accepted);
      expect(observed.signal).toBe(caller.signal);
      expect(caller.signal.aborted).toBe(cancelAfterCommit);
      expect(accepted.entry).toEqual(row);
      expect(accepted.previousSessionId).toBe(predecessorId);
      expect(row.sessionId).toBe(successorId);
      expect(edge.patch).toHaveBeenCalledOnce();
      // Acceptance keeps its existing fire-and-forget hook completion convention.
      expect(edge.end).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: predecessorId,
          sessionKey: target.sessionKey,
          reason: "compaction",
          nextSessionId: successorId,
          sessionFile: `sqlite:main:${predecessorId}:${target.storePath}`,
        }),
        { sessionId: predecessorId, sessionKey: target.sessionKey, agentId: "main" },
      );
      expect(edge.start).toHaveBeenCalledExactlyOnceWith(
        { sessionId: successorId, sessionKey: target.sessionKey, resumedFrom: predecessorId },
        { sessionId: successorId, sessionKey: target.sessionKey, agentId: "main" },
      );
      expect(
        listActiveSessionsForShutdown().filter((entry) => entry.sessionKey === target.sessionKey),
      ).toEqual([expect.objectContaining({ sessionId: successorId })]);
      if (cancelAfterCommit) {
        await caller.drain();
      }
      expect(hookSignals).toHaveLength(2);
      for (const signal of hookSignals) {
        expect(signal).toBeDefined();
        if (cancelAfterCommit) {
          expect(signal).not.toBe(caller.signal);
        }
        expect(signal?.aborted).toBe(false);
      }
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      endGate.resolve();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
      startGate.resolve();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      unsubscribe();
      endGate.resolve();
      startGate.resolve();
      await caller.drain();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    }
  },
);
