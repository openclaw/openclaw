import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import * as gatewayCallRuntime from "../../../gateway/call.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const noop = () => {};
let lifecycleHandler: ((event: AgentEventPayload) => void) | undefined;

const sessionStore = vi.hoisted(
  () =>
    new Proxy<Record<string, { sessionId: string; lifecycleRevision: string; updatedAt: number }>>(
      {},
      {
        get(target, prop, receiver) {
          if (typeof prop !== "string" || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return {
            sessionId: `sess-${prop}`,
            lifecycleRevision: `revision-${prop}`,
            updatedAt: 1,
          };
        },
      },
    ),
);

const gatewayCall = vi
  .spyOn(gatewayCallRuntime, "callGateway")
  .mockImplementation(async (request) =>
    request.method === "agent.wait" ? { status: "pending" } : {},
  );
afterAll(() => gatewayCall.mockRestore());

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("../../../config/sessions.js", () => {
  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => {
      const match = key.match(/^agent:([^:]+)/);
      return match?.[1] ?? "main";
    },
    resolveMainSessionKey: () => "agent:main:main",
    resolveSessionStorePathCore: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  loadSessionEntryReadOnly: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  patchSessionEntryCore: async () => null,
}));

const announceSpy = vi.fn(
  async (_params: unknown): Promise<"delivered" | "retryable"> => "delivered",
);
const runSubagentEndedHookMock = vi.fn(
  async (_eventValue?: Record<string, unknown>, _ctx?: Record<string, unknown>) => {},
);
const emitSessionLifecycleEventMock = vi.hoisted(() => vi.fn());
const removeInternalSessionEffectsSessionMock = vi.fn(async (_target?: unknown) => {});

function expectEnded(
  runId: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown> = {},
) {
  const call = runSubagentEndedHookMock.mock.calls.find(([, context]) => context?.runId === runId);
  expect(call?.[0]).toMatchObject(event);
  expect(call?.[1]).toMatchObject({ runId, ...ctx });
}

const noopContextEngine = {
  info: { id: "test-context-engine", name: "Test context engine" },
  ingest: async () => ({ ingested: false }),
  assemble: async () => ({ messages: [], estimatedTokens: 0 }),
  compact: async () => ({ ok: true, compacted: false }),
} satisfies ContextEngine;
vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../../../context-engine/init.js", () => ({ ensureContextEnginesInitialized: vi.fn() }));
vi.mock("../../../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(async () => noopContextEngine),
}));
vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: vi.fn(() => createEmptyPluginRegistry()) };
});

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_ended",
    runSubagentEnded: runSubagentEndedHookMock,
  })),
  getGlobalPluginRegistry: vi.fn(() => null),
  hasGlobalHooks: vi.fn((hookName: string) => hookName === "subagent_ended"),
  initializeGlobalHookRunner: vi.fn(),
  resetGlobalHookRunner: vi.fn(),
}));

vi.mock("../../../sessions/session-lifecycle-events.js", async (importOriginal) => {
  const { onSessionIdentityMutation } =
    await importOriginal<typeof import("../../../sessions/session-lifecycle-events.js")>();
  return { emitSessionLifecycleEvent: emitSessionLifecycleEventMock, onSessionIdentityMutation };
});

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: removeInternalSessionEffectsSessionMock,
}));

let mod: typeof import("./subagent-registry.test-helpers.js");
type RegisterSubagentRunInput = Parameters<typeof mod.registerSubagentRun>[0];
const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";

beforeAll(async () => {
  mod = await import("./subagent-registry.test-helpers.js");
});

beforeEach(async () => {
  setRuntimeConfigSnapshot(getRuntimeConfig());
  vi.useRealTimers();
  for (const key of Object.keys(sessionStore)) {
    delete sessionStore[key];
  }
  lifecycleHandler = undefined;
  announceSpy.mockReset().mockResolvedValue("delivered");
  runSubagentEndedHookMock.mockReset().mockImplementation(async () => {});
  emitSessionLifecycleEventMock.mockReset();
  removeInternalSessionEffectsSessionMock.mockClear();
  await mod.resetSubagentRegistryForTests({ persist: false });
});

const createDeferredAnnounce = () => {
  const entered = createDeferred();
  const delivery = createDeferred<"delivered" | "retryable">();
  announceSpy.mockImplementationOnce(() => {
    entered.resolve();
    return delivery.promise;
  });
  return { entered: entered.promise, resolve: delivery.resolve };
};

const registerRun = (
  runId: string,
  child: string,
  options: Partial<RegisterSubagentRunInput> = {},
) => {
  const childSessionKey = `agent:main:subagent:${child}`;
  const sessionEntry = {
    sessionId: `sess-${childSessionKey}`,
    lifecycleRevision: `revision-${childSessionKey}`,
    updatedAt: 1,
  };
  sessionStore[childSessionKey] = sessionEntry;
  return mod.registerSubagentRun({
    runId,
    childSessionKey,
    sessionEntry,
    childAgentId: "main",
    requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
    requesterDisplayKey: "main",
    task: runId,
    cleanup: "keep",
    ...options,
  });
};

const listMainRuns = () => mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY);

const observeTerminalPublication = (runId: string) => {
  const committed = createDeferred();
  const stop = subscribeSubagentRunChanges("projection", () => {
    if (mod.getSubagentRunByRunId(runId)?.execution.status === "terminal") {
      committed.resolve();
    }
  });
  onTestFinished(stop);
  return committed.promise;
};

const updateRun = (runId: string, amend: (draft: SubagentRunRecord) => void) =>
  mutateSubagentRuns([runId], (rows) => {
    const draft = structuredClone(expectDefined(rows.get(runId), "registered fixture row"));
    amend(draft);
    return { value: draft, postimages: new Map([[runId, draft]]) };
  });

const emitLifecycleEnd = (runId: string) =>
  lifecycleHandler?.({
    stream: "lifecycle",
    runId,
    seq: 1,
    ts: Date.now(),
    data: {
      phase: "end",
      terminalReply: { disposition: "visible", text: "final completion reply" },
    },
  });

const replaceRunAfterSteer = async (
  params: Parameters<typeof mod.replaceSubagentRunAfterSteerCore>[0],
) => {
  const replaced = await mod.replaceSubagentRunAfterSteerCore(params);
  expect(replaced).toBe(true);

  const runs = listMainRuns();
  expect(runs).toHaveLength(1);
  const run = expectDefined(runs[0], "replacement run");
  expect(run.runId).toBe(params.nextRunId);
  return run;
};

afterEach(async () => {
  await settleSubagentRegistryPersistenceWork();
  await mod.resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

it("honors persisted steer suppression and only announces the replacement run", async () => {
  const settleRootWork = observeRootWork();
  try {
    await registerRun("run-old", "steer");

    const previous = expectDefined(listMainRuns()[0], "registered run");
    expect(previous.runId).toBe("run-old");
    await updateRun(previous.runId, (draft) => {
      draft.suppressAnnounceReason = "steer-restart";
    });
    emitSessionLifecycleEventMock.mockClear();

    emitLifecycleEnd("run-old");

    await settleSubagentRegistryPersistenceWork(() => settleRootWork(true));
    expect(announceSpy).not.toHaveBeenCalled();
    expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
    expect(emitSessionLifecycleEventMock).not.toHaveBeenCalled();

    await replaceRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    emitLifecycleEnd("run-new");

    await settleSubagentRegistryPersistenceWork(() => settleRootWork(true));
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
    expectEnded("run-new", { runId: "run-new" });
    expect(announceSpy.mock.calls[0]?.[0]).toMatchObject({ childRunId: "run-new" });
  } finally {
    await settleRootWork();
  }
});

it.each(["run", "session"] as const)(
  "ends %s-mode hooks only after delivered completion",
  async (spawnMode) => {
    const runId = "run-completion";
    const childSessionKey = "agent:main:subagent:completion";
    const announce = createDeferredAnnounce();
    await registerRun(runId, "completion", {
      spawnMode,
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "discord", to: "channel:123", accountId: "work" },
    });
    if (spawnMode === "session") {
      expect(listMainRuns()[0]?.archiveAtMs).toBeUndefined();
    }
    try {
      emitLifecycleEnd(runId);
      await announce.entered;
      if (spawnMode === "run") {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      }
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      announce.resolve("delivered");
      await settleSubagentRegistryPersistenceWork();
      if (spawnMode === "run") {
        expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
        expectEnded(
          runId,
          {
            targetSessionKey: childSessionKey,
            reason: "subagent-complete",
            sendFarewell: true,
          },
          { requesterSessionKey: MAIN_REQUESTER_SESSION_KEY },
        );
      } else {
        expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
        const run = listMainRuns()[0];
        expect(run).toMatchObject({
          runId,
          cleanupCompletedAt: expect.any(Number),
        });
        expect(run?.endedHookEmittedAt).toBeUndefined();
      }
    } finally {
      announce.resolve("delivered");
    }
  },
);

it("clears terminal lifecycle state when replacing after steer restart", async () => {
  await registerRun("run-terminal-state-old", "terminal-state");
  const previous = expectDefined(listMainRuns()[0], "registered run");
  const endedAt = Date.now();
  await updateRun(previous.runId, (draft) => {
    draft.endedHookEmittedAt = endedAt;
    draft.endedReason = "subagent-error";
    draft.terminalOwner = "interrupted-recovery";
    draft.execution = { status: "terminal", endedAt, outcome: { status: "error" } };
    draft.completion = { required: true, resultText: "stale completion", capturedAt: endedAt };
    draft.cleanupCompletedAt = endedAt;
    draft.cleanupHandled = true;
    draft.archiveAtMs = endedAt;
    draft.delivery = {
      status: "suspended",
      attemptCount: 2,
      lastAttemptAt: endedAt,
      enqueuedAt: endedAt,
      deliveredAt: endedAt,
      announcedAt: endedAt,
      lastDropReason: "sink_unavailable",
      lastError: "gateway request timeout for agent",
      payload: {
        childRunId: draft.runId,
        childSessionKey: draft.childSessionKey,
        requesterSessionKey: draft.requesterSessionKey,
        requesterDisplayKey: draft.requesterDisplayKey,
        task: draft.task,
        endedAt,
      },
      suspendedAt: endedAt,
      suspendedReason: "expiry",
    };
  });

  const run = await replaceRunAfterSteer({
    previousRunId: previous.runId,
    nextRunId: "run-terminal-state-new",
    lifecycleGeneration: "test-generation",
  });
  expect(run).toMatchObject({
    task: previous.task,
    execution: { status: "running", lifecycleGeneration: "test-generation" },
    endedHookEmittedAt: undefined,
    endedReason: undefined,
    terminalOwner: undefined,
    cleanupCompletedAt: undefined,
    cleanupHandled: false,
    archiveAtMs: undefined,
  });
  expect([run.execution.endedAt, run.completion?.resultText, run.completion?.capturedAt]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(run.delivery).toEqual({ status: "pending" });

  const settleRootWork = observeRootWork();
  const terminalPublished = observeTerminalPublication(run.runId);
  try {
    emitLifecycleEnd(run.runId);
    await terminalPublished;
    await settleRootWork(true);
    expectEnded(run.runId, { runId: run.runId });
    expect(emitSessionLifecycleEventMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: previous.childSessionKey,
      reason: "subagent-status",
    });
  } finally {
    await settleRootWork();
  }
});

it("updates task to the dispatched steer message when provided", async () => {
  // Restart recovery must redispatch the steer instruction, not the original task.
  await registerRun("run-steer-task-old", "steer-task");

  expect(listMainRuns()[0]).toMatchObject({
    runId: "run-steer-task-old",
    taskRunId: "run-steer-task-old",
    generation: 1,
  });

  const run = await replaceRunAfterSteer({
    previousRunId: "run-steer-task-old",
    nextRunId: "run-steer-task-new",
    task: "new steer instruction from user",
  });

  expect(run).toMatchObject({
    task: "new steer instruction from user",
    taskRunId: "run-steer-task-old",
    generation: 2,
  });
});

it("preserves cumulative session timing across steer replacement runs", async () => {
  await registerRun("run-runtime-old", "runtime");

  const previous = expectDefined(listMainRuns()[0], "registered run");
  expect(previous?.runId).toBe("run-runtime-old");

  await updateRun(previous.runId, (draft) => {
    draft.execution.startedAt = 1_000;
    draft.sessionStartedAt = 1_000;
    draft.execution.endedAt = 121_000;
    draft.accumulatedRuntimeMs = 0;
    draft.execution.outcome = { status: "ok" };
  });

  const next = await replaceRunAfterSteer({
    previousRunId: "run-runtime-old",
    nextRunId: "run-runtime-new",
  });
  expect(mod.getSubagentSessionStartedAt(next)).toBe(1_000);
  expect(next.accumulatedRuntimeMs).toBe(120_000);

  if (!next.execution.startedAt) {
    throw new Error("missing next startedAt");
  }
  expect(mod.getSubagentSessionRuntimeMs(next, next.execution.startedAt + 30_000)).toBe(150_000);
});

it("rejects a replacement owned by a retired Gateway lifecycle", async () => {
  await registerRun("run-retired-generation-old", "retired-generation");

  expect(
    await mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-retired-generation-old",
      nextRunId: "run-retired-generation-new",
      lifecycleGeneration: "retired-generation",
    }),
  ).toBe(false);
  expect(listMainRuns()).toEqual([
    expect.objectContaining({ runId: "run-retired-generation-old" }),
  ]);
});

it("preserves frozen completion as fallback when replacing for wake continuation", async () => {
  await registerRun("run-wake-old", "wake");

  const previous = listMainRuns()[0];
  expect(previous?.runId).toBe("run-wake-old");
  await updateRun(expectDefined(previous, "registered run").runId, (draft) => {
    draft.completion = {
      required: true,
      resultText: "final summary before wake",
      capturedAt: 1234,
    };
  });

  const run = await replaceRunAfterSteer({
    previousRunId: "run-wake-old",
    nextRunId: "run-wake-new",
    preserveFrozenResultFallback: true,
  });
  expect(run.completion).toMatchObject({
    fallbackResultText: "final summary before wake",
    fallbackCapturedAt: 1234,
  });
  expect(run.completion?.resultText).toBeUndefined();
});

it("retries deferred parent cleanup after a descendant announces", async () => {
  let parentAttempts = 0;
  announceSpy.mockImplementation(async (params: unknown) => {
    const typed = params as { childRunId?: string };
    if (typed.childRunId === "run-parent") {
      parentAttempts += 1;
      return parentAttempts >= 2 ? "delivered" : "retryable";
    }
    return "delivered";
  });

  await registerRun("run-parent", "parent");
  await registerRun("run-child", "parent:subagent:child", {
    requesterSessionKey: "agent:main:subagent:parent",
    requesterDisplayKey: "parent",
  });

  const settleRootWork = observeRootWork();
  const parentPublished = observeTerminalPublication("run-parent");
  const childPublished = observeTerminalPublication("run-child");
  try {
    emitLifecycleEnd("run-parent");
    await parentPublished;
    await settleRootWork(true);
    const initialChildRunIds = announceSpy.mock.calls.map(
      (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
    );
    expect(initialChildRunIds.filter((id) => id === "run-parent")).toHaveLength(1);

    emitLifecycleEnd("run-child");
    await childPublished;
    await settleRootWork(true);
    const childRunIds = announceSpy.mock.calls.map(
      (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
    );
    expect(childRunIds.filter((id) => id === "run-parent")).toHaveLength(2);
    expect(childRunIds.filter((id) => id === "run-child")).toHaveLength(1);
  } finally {
    await settleRootWork();
  }
});
