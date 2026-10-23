// The shared fixture installs registry mocks before these consumers are evaluated.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { enqueueFollowupRun } from "../../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../../../auto-reply/reply/queue/cleanup.js";
import { getExistingFollowupQueue } from "../../../auto-reply/reply/queue/state.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  trackSessionControllerSourceWork,
} from "../../../sessions/session-controller.mailbox.js";
import {
  markReplyOperationExecutionStarted,
  recordOperationBackendRunId,
} from "../../../sessions/session-controller.state.js";
import { AgentSelectionRequiredError, resolveSessionAgentId } from "../../agent-scope.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import {
  createDurableSessionsSendTestRun,
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "../../openclaw-tools.sessions-steering.test-support.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "../../tools/in-process-gateway.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { captureSubagentCompletionReply } from "../announce/subagent-announce-output.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "./subagent-control-native.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { addSubagentRunForTests, getSubagentRunByRunId } from "./subagent-registry.test-helpers.js";

vi.mock("./subagent-registry-run-manager.js", { spy: true });

const fixture = useSubagentControlFixture();
const manager = vi.mocked(createSubagentRunManager).mock.results[0]!.value;
const rawConfig = (): OpenClawConfig => ({
  agents: {
    ownership: "explicit",
    entries: { main: {}, research: {} },
    defaults: { workspace: fixture.stateDir },
  },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
});
const sessionScope = (storePath: string, sessionKey = "global", agentId = "main") => ({
  agentId,
  storePath,
  sessionKey,
});
const readSession = (storePath: string, sessionKey = "global", agentId = "main") =>
  loadSessionEntry(sessionScope(storePath, sessionKey, agentId));
const writeSession = (agentId: string, sessionKey: string, defaultSessionId: string) =>
  writeSubagentSessionEntry({ stateDir: fixture.stateDir, agentId, sessionKey, defaultSessionId });
const sessionTarget = (
  storePath: string,
  incarnation: string,
  sessionKey = "global",
  agentId = "main",
) => captureSessionTarget({ storeScope: storePath, sessionKey, agentId, incarnation });
const cancelChild = (
  config: OpenClawConfig,
  agentSessionKey: string,
  runId: string,
  agentId = "main",
) =>
  createSubagentsTool({ config, agentId, agentSessionKey }).execute("cancel", {
    action: "cancel",
    runId,
  });
const cancelAdmin = (
  storePath: string,
  sessionKey: string,
  expectedRunId: string,
  expectedGeneration?: number,
) =>
  killSubagentRunAdmin({
    cfg: { session: { store: storePath } },
    sessionKey,
    agentId: "main",
    expectedRunId,
    expectedGeneration,
  });
function expectAccepted(result: { details: unknown }, expected: Record<string, unknown> = {}) {
  expect(result.details).toMatchObject({ status: "accepted", ...expected });
}
function queueFollowup(
  storePath: string,
  sessionId: string,
  sessionKey = "global",
  agentId = "main",
  config: OpenClawConfig = { session: { store: storePath } },
) {
  const followup = createQueueTestRun({ prompt: "Queued followup" });
  Object.assign(followup.run, { agentId, sessionKey, sessionId, config });
  const target = sessionTarget(storePath, sessionId, sessionKey, agentId);
  enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false);
  return { followup, target };
}
function expectNoSessionEffects() {
  for (const effect of [
    fixture.cleanup,
    fixture.gateway,
    fixture.capture,
    fixture.announce,
    fixture.wake,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
}
function protectSession(
  storePath: string,
  sessionKey: string,
  sessionId: string,
  agentId = "main",
  cfg?: OpenClawConfig,
) {
  const before = readSession(storePath, sessionKey);
  const { followup, target } = queueFollowup(storePath, sessionId, sessionKey, agentId, cfg);
  return {
    cleanup: () => clearSessionQueues([sessionKey], target),
    check: () => {
      expect(readSession(storePath, sessionKey)).toEqual(before);
      expect(getExistingFollowupQueue(sessionKey, target)?.items).toContain(followup);
      expectNoSessionEffects();
    },
  };
}
function nativeController(storePath: string, sessionKey: string, sessionId: string, runId: string) {
  return registerChatAbortController({
    target: sessionTarget(storePath, sessionId, sessionKey),
    runId,
    sessionKey,
    sessionId,
    kind: "agent",
    timeoutMs: 60_000,
  });
}
async function rawChild(agentId: string) {
  const sessionId = `${agentId}-global`;
  const parentKey = `agent:${agentId}:dashboard:parent`;
  const storePath = await writeSession(agentId, parentKey, `${agentId}-parent`);
  await replaceSessionEntry(sessionScope(storePath, "global", agentId), {
    sessionId,
    lifecycleRevision: `${sessionId}-revision`,
    updatedAt: Date.now(),
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    spawnDepth: 1,
    createdVia: "spawn",
    createdActor: { type: "agent", id: agentId },
  });
  return { storePath, parentKey };
}

it("cancelling a watched main/global child preserves the newer foreign row and other work", async () => {
  const { cfg, children } = await prepareWatchedRawChildren();
  expect(() => resolveSessionAgentId({ config: cfg, sessionKey: "global" })).toThrow(
    AgentSelectionRequiredError,
  );
  const { storePath: childStorePath, parentKey } = children.get("main")!;
  const foreignStorePath = children.get("research")!.storePath;
  const childId = "main-global",
    foreignId = "research-global",
    foreignAgent = "research";
  const foreignAbort = vi.fn();
  const foreignHandle = createEmbeddedRunHandle({ runId: "foreign-run", abort: foreignAbort });
  attachActiveEmbeddedRun(
    foreignId,
    foreignHandle,
    "global",
    foreignStorePath,
    undefined,
    foreignAgent,
  );
  const { followup, target: foreignTarget } = queueFollowup(
    foreignStorePath,
    foreignId,
    "global",
    foreignAgent,
    cfg,
  );
  const childTarget = sessionTarget(childStorePath, childId);
  const childSource = nativeController(childStorePath, "global", childId, "main-1");
  const foreignTurn = vi.fn(async () => "foreign command survived");
  const childTurn = vi.fn(async () => "unrelated child turn survived");
  const foreignCommand = withSessionTurn(
    { sessionKey: "global", sessionId: foreignId, target: foreignTarget },
    foreignTurn,
  );
  const childCommand = withSessionTurn(
    { sessionKey: "global", sessionId: childId, target: childTarget },
    childTurn,
  );
  const outcome = Promise.allSettled([foreignCommand, childCommand]);
  const interruptChild = vi.fn(() => childAdmission.release());
  const childAdmission = await beginSessionEffect({
    target: childTarget,
    sourceInput: childSource.entry!.input,
    assertAllowed: () => {},
    onInterrupt: interruptChild,
  });
  try {
    const cancelled = await cancelChild(cfg, parentKey, "main-1");
    expect(cancelled.details).toMatchObject({ found: true, killed: true });
    expect(getSubagentRunByRunId("research-2")?.execution.endedAt).toBeUndefined();
    expect(readSession(childStorePath)?.abortedLastRun).not.toBe(true);
    expect.soft(foreignAbort).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue("global", foreignTarget)?.items).toContain(followup);
    expect(childSource.controller.signal.aborted).toBe(true);
    expect(foreignTurn).not.toHaveBeenCalled();
    clearSessionQueues(["global"], foreignTarget, [followup.controllerInput!]);
    await detachActiveEmbeddedRun(foreignId, foreignHandle, "global");
    expect(await outcome).toEqual([
      { status: "fulfilled", value: "foreign command survived" },
      { status: "fulfilled", value: "unrelated child turn survived" },
    ]);
    expect(readSession(foreignStorePath, "global", foreignAgent)?.abortedLastRun).not.toBe(true);
  } finally {
    childAdmission.release();
    childSource.cleanup();
    clearSessionQueues(["global"], childTarget);
    clearSessionQueues(["global"], foreignTarget);
    await detachActiveEmbeddedRun(foreignId, foreignHandle, "global");
    await outcome;
  }
});

async function prepareWatchedRawChildren() {
  const cfg = rawConfig();
  setRuntimeConfigSnapshot(cfg);
  let sequence = 0;
  const callGateway: AgentToolGatewayRequestCaller = async (request) => {
    if (request.method !== "agent") {
      throw new Error(`Unexpected tool RPC ${request.method}`);
    }
    request.assertDispatchCurrent?.();
    const params = request.params as { agentId: string };
    return { runId: `${params.agentId}-${++sequence}`, status: "accepted" } as never;
  };
  const children = new Map<string, { storePath: string; parentKey: string }>();
  for (const agentId of ["main", "research"]) {
    children.set(agentId, await rawChild(agentId));
  }
  const send = (agentId: string, turn: string, mode: "followup" | "steer" = "followup") =>
    createSessionsSendTool({
      config: cfg,
      agentId,
      agentSessionKey: children.get(agentId)!.parentKey,
      requesterTurnRunId: turn,
      callGateway,
    }).execute("send", {
      sessionKey: "global",
      message: `Continue ${agentId}`,
      mode,
      watch: true,
      timeoutSeconds: 0,
    });
  expectAccepted(await send("main", "main-turn"), { watched: false });
  expectAccepted(await send("research", "research-turn"));
  return { cfg, children, send };
}

it.each([
  { owner: "main", foreignStatus: undefined },
  { owner: "research", foreignStatus: "failed" },
] as const)(
  "settles $owner/global from its own transcript and metadata (foreign=$foreignStatus)",
  async ({ owner, foreignStatus }) => {
    const runId = owner === "main" ? "main-1" : "research-2";
    const waits = vi.spyOn(manager, "waitForSubagentCompletion");
    const terminal = createDeferred<{
      status: "timeout";
      startedAt: number;
      endedAt: number;
    }>();
    fixture.gateway.mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      const params = request.params as { runId?: string };
      return (await (params.runId === runId
        ? terminal.promise
        : new Promise<never>(() => {}))) as never;
    });
    fixture.capture.mockImplementation(captureSubagentCompletionReply);
    const { children } = await prepareWatchedRawChildren();
    for (const [agentId, { storePath }] of children) {
      await appendTranscriptMessage(
        { agentId, storePath, sessionKey: "global", sessionId: `${agentId}-global` },
        {
          message: {
            role: "assistant",
            content: `${agentId}'s partial result`,
            phase: "final",
            stopReason: "stop",
            __openclaw: { runId: agentId === "main" ? "main-1" : "research-2" },
          },
        },
      );
    }
    const entry = getSubagentRunByRunId(runId)!;
    if (foreignStatus) {
      const scope = sessionScope(children.get("main")!.storePath);
      await replaceSessionEntry(scope, {
        ...loadSessionEntry(scope)!,
        status: foreignStatus,
        endedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    // A timeout without producer reply metadata must read this child's own transcript.
    terminal.resolve({
      status: "timeout",
      startedAt: entry.createdAt,
      endedAt: Date.now(),
    });
    const waitIndex = waits.mock.calls.findIndex(([waitingRunId]) => waitingRunId === runId);
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    await waits.mock.results[waitIndex]!.value;
    await fixture.settle();
    expect(getSubagentRunByRunId(runId)).toMatchObject({
      childAgentId: owner,
      execution: { status: "terminal", outcome: { status: "timeout" } },
      completion: { resultText: `${owner}'s partial result` },
    });
    expect(readSession(children.get(owner)!.storePath, "global", owner)).toMatchObject({
      status: "timeout",
    });
    const foreignRunId = owner === "main" ? "research-2" : "main-1";
    expect(getSubagentRunByRunId(foreignRunId)?.execution.endedAt).toBeUndefined();
  },
);

it("numbers watched raw children independently and keeps their completion owner", async () => {
  const { children, send } = await prepareWatchedRawChildren();
  const { storePath, parentKey } = children.get("main")!;
  const scope = sessionScope(storePath);
  const entry = loadSessionEntry(scope)!;
  const otherParentKey = "agent:main:dashboard:other";
  await writeSession("main", otherParentKey, "main-other-parent");
  // Retained completion custody survives a valid spawn-link change, not a missing ancestor.
  await replaceSessionEntry(scope, {
    ...entry,
    spawnedBy: otherParentKey,
    parentSessionKey: otherParentKey,
    parentSessionId: "main-other-parent",
  });
  expectAccepted(await send("main", "main-next-turn"));
  expect(getSubagentRunByRunId("main-3")).toMatchObject({
    childAgentId: "main",
    generation: 2,
    requesterAgentId: "main",
    requesterSessionKey: parentKey,
    requesterTurnRunId: "main-next-turn",
    completionRequesterSessionId: "main-parent",
  });
  expect(getSubagentRunByRunId("research-2")).toMatchObject({
    generation: 1,
    requesterTurnRunId: "research-turn",
    execution: { status: "running" },
  });
});

it("steers its watched raw child while another agent has a newer row", async () => {
  const { cfg, children, send } = await prepareWatchedRawChildren();
  const caller = createSessionsSendTestCaller(children.get("main")!.parentKey);
  const { handle, queueMessage } = createDurableSessionsSendTestRun("main-1");
  const close = await setSessionsSendTestActiveRun(
    "main-global",
    handle,
    "global",
    caller.sessionKey,
    cfg,
  );
  try {
    const sent = await withoutGatewayToolCallerIdentity(() =>
      withGatewayToolCallerIdentity(caller, () => send("main", "main-turn", "steer")),
    );
    expectAccepted(sent, { targetDisposition: "steered" });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(
      await loadTranscriptEvents({
        agentId: "main",
        storePath: children.get("main")!.storePath,
        sessionKey: "global",
        sessionId: "main-global",
      }),
    ).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Continue main"),
          provenance: {
            kind: "inter_session",
            sourceSessionKey: children.get("main")!.parentKey,
            sourceTool: "sessions_send",
          },
          __openclaw: { steerTargetRunId: "main-1", requesterOrigin: caller.requesterOrigin },
        }),
      }),
    );
    expect(
      await loadTranscriptEvents({
        agentId: "research",
        storePath: children.get("research")!.storePath,
        sessionKey: "global",
        sessionId: "research-global",
      }),
    ).toEqual([]);
    expect(getSubagentRunByRunId("main-1")?.requesterTurnRunId).toBe("main-turn");
    expect(getSubagentRunByRunId("research-2")?.requesterTurnRunId).toBe("research-turn");
  } finally {
    await close();
  }
});

it.each(["main-3", "main-4"])(
  "cancels queued followup %s while the active run and other followup complete",
  async (cancelledRunId) => {
    const { cfg, children, send } = await prepareWatchedRawChildren();
    const { storePath, parentKey } = children.get("main")!;
    const target = sessionTarget(storePath, "main-global");
    const entered = createDeferred();
    const release = createDeferred();
    const interrupted = vi.fn(() => release.resolve());
    const reserve = (runId: string) =>
      reserveSessionControllerSource("global", {
        target,
        protocolRunId: runId,
        policy: { mode: "followup" },
      });
    const turn = { target, sessionKey: "global", sessionId: "main-global", agentId: "main" };
    const activeInput = reserve("main-1");
    const active = withSessionTurn(
      { ...turn, controllerInput: activeInput },
      async (operation, signal) => {
        recordOperationBackendRunId(operation!, "main-1");
        const admission = await beginSessionEffect({
          target,
          sourceInput: activeInput,
          assertAllowed: () => {},
          onInterrupt: interrupted,
        });
        entered.resolve();
        try {
          await release.promise;
          signal.throwIfAborted();
          return "active completed";
        } finally {
          admission.release();
        }
      },
    );
    await awaitGateBeforeSettlement(entered.promise, active, "Active turn did not start");
    const completed: string[] = [];
    const followups: Promise<string>[] = [];
    try {
      for (const runId of ["main-3", "main-4"]) {
        expectAccepted(await send("main", "main-turn"), { runId });
        followups.push(
          withSessionTurn({ ...turn, controllerInput: reserve(runId) }, async () => {
            completed.push(runId);
            return runId;
          }),
        );
      }
      const outcomes = Promise.allSettled(followups);
      const sessionBefore = loadSessionEntry(sessionScope(storePath));
      const cancelled = await cancelChild(cfg, parentKey, cancelledRunId);
      expect(cancelled.details).toMatchObject({ found: true, killed: true });
      expect(interrupted).not.toHaveBeenCalled();
      expect(activeInput.abortSignal.aborted).toBe(false);
      expect(completed).toEqual([]);
      expect(loadSessionEntry(sessionScope(storePath))).toEqual(sessionBefore);
      release.resolve();
      await expect(active).resolves.toBe("active completed");
      const survivor = cancelledRunId === "main-3" ? "main-4" : "main-3";
      expect(await outcomes).toMatchObject(
        cancelledRunId === "main-3"
          ? [{ status: "rejected" }, { status: "fulfilled", value: survivor }]
          : [{ status: "fulfilled", value: survivor }, { status: "rejected" }],
      );
      expect(completed).toEqual([survivor]);
      expect(getSubagentRunByRunId(cancelledRunId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
      expect(getSubagentRunByRunId(survivor)?.execution.endedAt).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([active, ...followups]);
    }
  },
);

it("keeps a watched registration current while the other raw owner commits", async () => {
  const { send } = await prepareWatchedRawChildren();
  const entered = createDeferred();
  const release = createDeferred();
  fixture.interceptWorkerCommand((command) => {
    if (
      isSubagentRegistryWriteCommand(command) &&
      command.input.values.some((row) => row.run_id === "main-3")
    ) {
      entered.resolve();
      return release.promise;
    }
    return undefined;
  });
  const pending = send("main", "main-concurrent-turn");
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Watched registration settled before its registry write",
    );
    expectAccepted(await send("research", "research-concurrent-turn"));
  } finally {
    release.resolve();
  }
  expectAccepted(await pending);
  expect(getSubagentRunByRunId("main-3")).toMatchObject({
    generation: 2,
    requesterTurnRunId: "main-concurrent-turn",
  });
  expect(getSubagentRunByRunId("research-4")).toMatchObject({
    generation: 2,
    requesterTurnRunId: "research-concurrent-turn",
  });
});

it.each(["admin", "bulk", "tool"] as const)(
  "%s cancellation refuses retained raw children without guessing their owner",
  async (action) => {
    const storePath = await writeSession("main", "global", "legacy-global");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        entries: { main: {}, research: {} },
        defaults: { workspace: fixture.stateDir, sessionStore: { agentId: "main" } },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const owner of ["research", "main"]) {
      await addSubagentRunForTests({
        runId: `${owner}-legacy`,
        childSessionKey: "global",
        requesterSessionKey: `agent:${owner}:main`,
        requesterAgentId: owner,
        childSessionIdentity: { sessionId: "legacy-global" },
      });
    }
    const research = getSubagentRunByRunId("research-legacy")!;
    expect(research.childAgentId).toBeUndefined();
    expect(getSubagentRunByRunId("main-legacy")?.childAgentId).toBeUndefined();
    const before = structuredClone(research);
    const protectedSession = protectSession(storePath, "global", "legacy-global", "research", cfg);
    try {
      const result =
        action === "admin"
          ? await killSubagentRunAdmin({
              cfg,
              sessionKey: "global",
              agentId: "research",
              expectedRunId: "research-legacy",
            })
          : action === "tool"
            ? (await cancelChild(cfg, "agent:research:main", "research-legacy", "research")).details
            : await killAllControlledSubagentRuns({
                cfg,
                controller: {
                  controllerSessionKey: "agent:research:main",
                  controllerAgentId: "research",
                  callerSessionKey: "agent:research:main",
                  callerIsSubagent: false,
                  controlScope: "children",
                },
                runs: [research],
              });
      expect(result).toMatchObject({
        ...(action === "bulk"
          ? { status: "error", killed: 0, failed: 1 }
          : { found: true, killed: false, cascadeKilled: 0 }),
        ...(action === "admin" ? { runId: "research-legacy" } : {}),
        error: expect.stringContaining("owning agent is unresolved"),
      });
      expect(getSubagentRunByRunId("research-legacy")).toEqual(before);
      expect(getSubagentRunByRunId("main-legacy")?.execution.endedAt).toBeUndefined();
      protectedSession.check();
    } finally {
      protectedSession.cleanup();
    }
  },
);

it.each([
  { sessionKey: "global", childAgentId: "main", bindNativeRun: true },
  { sessionKey: "agent:main:subagent:legacy", childAgentId: undefined, bindNativeRun: false },
])(
  "cancels only the legacy task on $sessionKey despite a newer owned incarnation (native=$bindNativeRun)",
  async ({ sessionKey, childAgentId, bindNativeRun }) => {
    const storePath = await writeSession("main", sessionKey, "replacement");
    const cfg: OpenClawConfig = { session: { store: storePath } };
    await addSubagentRunForTests({
      runId: "unbound-incarnation",
      childSessionKey: sessionKey,
      childAgentId,
      childSessionIdentity: undefined,
      generation: 1,
    });
    const scope = sessionScope(storePath, sessionKey);
    const sessionBefore = loadSessionEntry(scope);
    expect(sessionBefore).toBeDefined();
    await addSubagentRunForTests({
      runId: "next-incarnation",
      childSessionKey: sessionKey,
      childAgentId: "main",
      childSessionIdentity: sessionBefore,
      generation: 2,
    });
    const legacyRun = getSubagentRunByRunId("unbound-incarnation")!;
    const nextBefore = structuredClone(getSubagentRunByRunId("next-incarnation"));
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const nativeRun = nativeController(storePath, sessionKey, "original-session", legacyRun.runId);
    const successorRun = nativeController(
      storePath,
      sessionKey,
      sessionBefore!.sessionId,
      "next-incarnation",
    );
    const nativeReleased = createDeferred();
    const nativeEntered = createDeferred();
    nativeRun.controller.signal.addEventListener("abort", () => nativeReleased.resolve(), {
      once: true,
    });
    const nativeExecution = withSessionTurn(
      {
        sessionKey,
        sessionId: "original-session",
        agentId: "main",
        storePath,
        controllerInput: nativeRun.entry!.input,
      },
      async (operation) => {
        if (!operation) {
          throw new Error("Native source did not claim a session operation");
        }
        markReplyOperationExecutionStarted(operation);
        nativeEntered.resolve();
        try {
          await nativeReleased.promise;
        } finally {
          nativeRun.cleanup();
        }
      },
    );
    trackSessionControllerSourceWork(nativeRun.entry!.input, nativeExecution);
    await awaitGateBeforeSettlement(
      nativeEntered.promise,
      nativeExecution,
      "Native source did not begin execution",
    );
    if (bindNativeRun) {
      bindGatewayContextResolver(legacyRun, () => context);
    }
    const protectedSession = protectSession(storePath, sessionKey, sessionBefore!.sessionId);
    fixture.worker.mockClear();
    try {
      expect(await cancelAdmin(storePath, sessionKey, "unbound-incarnation", 2)).toEqual({
        found: false,
        killed: false,
      });
      expect(getSubagentRunByRunId("unbound-incarnation")?.execution.status).toBe("running");
      expect(await cancelAdmin(storePath, sessionKey, "unbound-incarnation")).toMatchObject({
        found: true,
        killed: true,
        runId: "unbound-incarnation",
        cascadeKilled: 0,
      });
      expect(getSubagentRunByRunId("unbound-incarnation")).toMatchObject({
        childSessionIdentity: undefined,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        execution: { status: "terminal", suppressSessionEffects: true },
      });
      expect(nativeRun.controller.signal.aborted).toBe(true);
      expect(successorRun.controller.signal.aborted).toBe(false);
      expect(getSubagentRunByRunId("next-incarnation")).toEqual(nextBefore);
      protectedSession.check();
    } finally {
      clearGatewayContextResolver(legacyRun);
      nativeReleased.resolve();
      await nativeExecution;
      nativeRun.cleanup();
      successorRun.cleanup();
      protectedSession.cleanup();
    }
  },
);

it.each(["registration", "execution target"] as const)(
  "limits cancellation when the %s omitted the current session's lifecycle revision",
  async (identitySource) => {
    const sessionKey = "agent:main:subagent:revision-reused-id";
    const sessionId = "reused-session-id";
    const runId = "revision-fenced-run";
    const storePath = await writeSession("main", sessionKey, sessionId);
    const scope = sessionScope(storePath, sessionKey);
    const lifecycleRevision = "successor-revision";
    await addSubagentRunForTests({
      runId,
      childSessionKey: sessionKey,
      childAgentId: "main",
      childSessionIdentity: {
        sessionId,
        lifecycleRevision: identitySource === "registration" ? undefined : lifecycleRevision,
      },
      execution: {
        status: "running",
        ...(identitySource === "execution target"
          ? { transcriptTarget: { agentId: "main", sessionKey, sessionId, storePath } }
          : {}),
      },
    });
    await replaceSessionEntry(scope, {
      ...loadSessionEntry(scope)!,
      lifecycleRevision,
    });
    const before = structuredClone(getSubagentRunByRunId(runId));
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    abort.mockImplementation(() => detachActiveEmbeddedRun(sessionId, handle, sessionKey));
    attachActiveEmbeddedRun(sessionId, handle, sessionKey, storePath, undefined, "main");
    const protectedSession = protectSession(storePath, sessionKey, sessionId);
    fixture.worker.mockClear();
    try {
      expect(await cancelAdmin(storePath, sessionKey, runId)).toMatchObject({
        found: true,
        killed: identitySource === "registration",
        runId,
        cascadeKilled: 0,
        ...(identitySource === "execution target"
          ? { error: expect.stringContaining("session changed during cancellation preparation") }
          : {}),
      });
      if (identitySource === "registration") {
        expect(getSubagentRunByRunId(runId)).toMatchObject({
          childSessionIdentity: { sessionId, lifecycleRevision: undefined },
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          execution: { status: "terminal", suppressSessionEffects: true },
        });
      } else {
        expect(getSubagentRunByRunId(runId)).toEqual(before);
        expect(fixture.worker).not.toHaveBeenCalled();
      }
      expect(abort).toHaveBeenCalledTimes(identitySource === "registration" ? 1 : 0);
      protectedSession.check();
    } finally {
      await detachActiveEmbeddedRun(sessionId, handle, sessionKey);
      protectedSession.cleanup();
    }
  },
);
