// The shared fixture installs registry mocks before these consumers are evaluated.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
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
import { trackSessionControllerSourceWork } from "../../../sessions/session-controller.mailbox.js";
import { markReplyOperationExecutionStarted } from "../../../sessions/session-controller.state.js";
import { AgentSelectionRequiredError, resolveSessionAgentId } from "../../agent-scope.js";
import type { EmbeddedAgentQueueHandle } from "../../embedded-agent-runner/run-state.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
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

// sessions.create composition is proven separately. These rows retain its
// spawnedBy/spawnDepth contract; the actual send tool must create the run record.
it("cancelling a watched main/global child preserves the other agent's work", async () => {
  const owner = "main";
  const foreignAgent = "research";
  const parentKey = `agent:${owner}:dashboard:parent`;
  const childId = `${owner}-global-session`;
  const foreignId = `${foreignAgent}-global-session`;
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, research: {} },
      defaults: { workspace: fixture.stateDir },
    },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  };
  setRuntimeConfigSnapshot(cfg);
  const childStorePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: owner,
    sessionKey: "global",
    defaultSessionId: childId,
  });
  await replaceSessionEntry(
    { agentId: owner, storePath: childStorePath, sessionKey: "global" },
    {
      sessionId: childId,
      lifecycleRevision: `${childId}-revision`,
      updatedAt: Date.now(),
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      spawnDepth: 1,
      createdVia: "spawn",
      createdActor: { type: "agent", id: owner },
    },
  );
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: owner,
    sessionKey: parentKey,
    defaultSessionId: `${owner}-parent-session`,
  });
  const foreignStorePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: foreignAgent,
    sessionKey: "global",
    defaultSessionId: foreignId,
  });
  const dispatched: Record<string, unknown>[] = [];
  const callGateway: AgentToolGatewayRequestCaller = async (request) => {
    if (request.method !== "agent") {
      throw new Error(`Unexpected tool RPC ${request.method}`);
    }
    request.assertDispatchCurrent?.();
    dispatched.push(request.params as Record<string, unknown>);
    return { runId: "watched-global-run", status: "accepted" } as never;
  };
  const sent = await createSessionsSendTool({
    config: cfg,
    agentId: owner,
    agentSessionKey: parentKey,
    requesterTurnRunId: "parent-turn",
    callGateway,
  }).execute("send", {
    sessionKey: "global",
    message: "Continue the child task",
    mode: "followup",
    watch: true,
    timeoutSeconds: 0,
  });
  expect(sent.details).toMatchObject({ status: "accepted", watched: false });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toMatchObject({ agentId: owner, sessionKey: "global" });
  expect.soft(getSubagentRunByRunId("watched-global-run")).toMatchObject({
    childSessionKey: "global",
    childAgentId: owner,
    requesterSessionKey: parentKey,
    requesterAgentId: owner,
  });
  expect(() => resolveSessionAgentId({ config: cfg, sessionKey: "global" })).toThrow(
    AgentSelectionRequiredError,
  );

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
  const followup = createQueueTestRun({ prompt: "Other agent's queued followup" });
  Object.assign(followup.run, {
    agentId: foreignAgent,
    sessionKey: "global",
    sessionId: foreignId,
    config: cfg,
  });
  const foreignTarget = captureSessionTarget({
    storeScope: foreignStorePath,
    sessionKey: "global",
    agentId: foreignAgent,
    incarnation: foreignId,
  });
  enqueueFollowupRun("global", followup, { mode: "followup" }, "none", undefined, false);
  const childTarget = captureSessionTarget({
    storeScope: childStorePath,
    sessionKey: "global",
    agentId: owner,
    incarnation: childId,
  });
  const childSource = registerChatAbortController({
    target: childTarget,
    runId: "child-preparing-run",
    sessionKey: "global",
    sessionId: childId,
    kind: "agent",
    timeoutMs: 60_000,
  });
  const foreignTurn = vi.fn(async () => "foreign command survived");
  const childTurn = vi.fn(async () => "child must not start");
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
    assertAllowed: () => {},
    onInterrupt: interruptChild,
  });
  try {
    const cancelled = await createSubagentsTool({
      config: cfg,
      agentId: owner,
      agentSessionKey: parentKey,
    }).execute("cancel", { action: "cancel", runId: "watched-global-run" });
    expect(cancelled.details).toMatchObject({ found: true, killed: true });
    expect(interruptChild).toHaveBeenCalledOnce();
    expect(
      loadSessionEntry({ agentId: owner, storePath: childStorePath, sessionKey: "global" }),
    ).toMatchObject({ abortedLastRun: true, status: "killed" });
    expect.soft(foreignAbort).not.toHaveBeenCalled();
    expect
      .soft(getExistingFollowupQueue("global", foreignTarget)?.items.includes(followup) ?? false)
      .toBe(true);
    expect(childSource.controller.signal.aborted).toBe(true);
    expect(childTurn).not.toHaveBeenCalled();
    expect(foreignTurn).not.toHaveBeenCalled();
    clearSessionQueues(["global"], foreignTarget, [followup.controllerInput!]);
    await detachActiveEmbeddedRun(foreignId, foreignHandle, "global");
    const [foreignResult, childResult] = await outcome;
    expect.soft(foreignResult).toEqual({ status: "fulfilled", value: "foreign command survived" });
    expect(foreignTurn).toHaveBeenCalledOnce();
    expect(childResult).toMatchObject({
      status: "rejected",
      reason: { message: "Session mailbox cleared" },
    });
    expect
      .soft(
        loadSessionEntry({
          agentId: foreignAgent,
          storePath: foreignStorePath,
          sessionKey: "global",
        })?.abortedLastRun,
      )
      .not.toBe(true);
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
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, research: {} },
      defaults: { workspace: fixture.stateDir },
    },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  };
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
    const parentKey = `agent:${agentId}:dashboard:parent`;
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId,
      sessionKey: parentKey,
      defaultSessionId: `${agentId}-parent`,
    });
    await replaceSessionEntry(
      { agentId, storePath, sessionKey: "global" },
      {
        sessionId: `${agentId}-global`,
        lifecycleRevision: `${agentId}-global-revision`,
        updatedAt: Date.now(),
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        spawnDepth: 1,
        createdVia: "spawn",
        createdActor: { type: "agent", id: agentId },
      },
    );
    children.set(agentId, { storePath, parentKey });
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
  expect((await send("main", "main-turn")).details).toMatchObject({ status: "accepted" });
  expect((await send("research", "research-turn")).details).toMatchObject({ status: "accepted" });
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
    expect(entry.execution.transcriptTarget).toBeUndefined();
    if (foreignStatus) {
      const scope = {
        agentId: "main",
        storePath: children.get("main")!.storePath,
        sessionKey: "global",
      };
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
    expect(fixture.capture).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({
        outcome: expect.objectContaining({ status: "timeout" }),
        sessionTarget: expect.objectContaining({ agentId: owner, sessionId: `${owner}-global` }),
      }),
    );
    expect(getSubagentRunByRunId(runId)).toMatchObject({
      childAgentId: owner,
      execution: { status: "terminal", outcome: { status: "timeout" } },
      completion: { resultText: `${owner}'s partial result` },
    });
    expect(
      loadSessionEntry({
        agentId: owner,
        storePath: children.get(owner)!.storePath,
        sessionKey: "global",
      }),
    ).toMatchObject({ status: "timeout" });
    const foreignRunId = owner === "main" ? "research-2" : "main-1";
    expect(getSubagentRunByRunId(foreignRunId)?.execution.endedAt).toBeUndefined();
  },
);

it("numbers watched raw children independently and keeps their completion owner", async () => {
  const { children, send } = await prepareWatchedRawChildren();
  expect.soft(getSubagentRunByRunId("main-1")?.generation).toBe(1);
  expect.soft(getSubagentRunByRunId("research-2")?.generation).toBe(1);
  const { storePath, parentKey } = children.get("main")!;
  const scope = { agentId: "main", storePath, sessionKey: "global" };
  const entry = loadSessionEntry(scope)!;
  const otherParentKey = "agent:main:dashboard:other";
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: otherParentKey,
    defaultSessionId: "main-other-parent",
  });
  // Retained completion custody survives a valid spawn-link change, not a missing ancestor.
  await replaceSessionEntry(scope, {
    ...entry,
    spawnedBy: otherParentKey,
    parentSessionKey: otherParentKey,
    parentSessionId: "main-other-parent",
  });
  const sent = await send("main", "main-next-turn");
  expect(sent.details, JSON.stringify(sent.details)).toMatchObject({ status: "accepted" });
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
  const { send } = await prepareWatchedRawChildren();
  const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(async () => {});
  const handle: EmbeddedAgentQueueHandle = {
    ...createEmbeddedRunHandle({ runId: "main-1", queueMessage }),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, options, assertCurrent) => {
        assertCurrent();
        await queueMessage(text, options);
      },
    },
  };
  attachActiveEmbeddedRun("main-global", handle, "global", undefined, undefined, "main");
  try {
    const sent = await send("main", "main-turn", "steer");
    expect(sent.details, JSON.stringify(sent.details)).toMatchObject({
      status: "accepted",
      targetDisposition: "steered",
    });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(getSubagentRunByRunId("main-1")?.requesterTurnRunId).toBe("main-turn");
    expect(getSubagentRunByRunId("research-2")?.requesterTurnRunId).toBe("research-turn");
  } finally {
    await detachActiveEmbeddedRun("main-global", handle, "global");
  }
});

it("cancels its selected raw child while another agent has a newer watched row", async () => {
  const { cfg, children } = await prepareWatchedRawChildren();
  const result = await createSubagentsTool({
    config: cfg,
    agentId: "main",
    agentSessionKey: children.get("main")!.parentKey,
  }).execute("cancel", { action: "cancel", runId: "main-1" });
  expect(result.details).toMatchObject({ found: true, killed: true });
  expect(getSubagentRunByRunId("research-2")?.execution.endedAt).toBeUndefined();
});

it("keeps a watched registration current while the other raw owner commits", async () => {
  const { send } = await prepareWatchedRawChildren();
  const entered = createDeferred();
  const release = createDeferred();
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          execute: async (command, commandOptions) => {
            if (
              isSubagentRegistryWriteCommand(command) &&
              command.input.values.some((row) => row.run_id === "main-3")
            ) {
              entered.resolve();
              await release.promise;
            }
            return scope.execute(command, commandOptions);
          },
        }),
      options,
    ),
  );
  const pending = send("main", "main-concurrent-turn");
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Watched registration settled before its registry write",
    );
    expect((await send("research", "research-concurrent-turn")).details).toMatchObject({
      status: "accepted",
    });
  } finally {
    release.resolve();
  }
  expect((await pending).details).toMatchObject({ status: "accepted" });
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
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      sessionKey: "global",
      agentId: "main",
      defaultSessionId: "legacy-global",
    });
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
        requesterDisplayKey: owner,
        task: `${owner} work`,
        cleanup: "keep",
        childSessionIdentity: { sessionId: "legacy-global" },
      });
    }
    const research = getSubagentRunByRunId("research-legacy")!;
    expect(research.childAgentId).toBeUndefined();
    expect(getSubagentRunByRunId("main-legacy")?.childAgentId).toBeUndefined();
    const before = structuredClone(research);
    const sessionBefore = loadSessionEntry({ agentId: "main", storePath, sessionKey: "global" });
    const followup = createQueueTestRun({ prompt: "Retained queued followup" });
    Object.assign(followup.run, {
      agentId: "research",
      sessionKey: "global",
      sessionId: "legacy-global",
      config: cfg,
    });
    const target = captureSessionTarget({
      storeScope: storePath,
      sessionKey: "global",
      agentId: "research",
      incarnation: "legacy-global",
    });
    enqueueFollowupRun("global", followup, { mode: "followup" }, "none", undefined, false);

    try {
      if (action === "admin") {
        const result = await killSubagentRunAdmin({
          cfg,
          sessionKey: "global",
          agentId: "research",
          expectedRunId: "research-legacy",
        });
        expect(result).toMatchObject({
          found: true,
          killed: false,
          runId: "research-legacy",
          cascadeKilled: 0,
        });
        expect(result).toHaveProperty(
          "error",
          expect.stringContaining("owning agent is unresolved"),
        );
      } else if (action === "tool") {
        const result = await createSubagentsTool({
          config: cfg,
          agentId: "research",
          agentSessionKey: "agent:research:main",
        }).execute("cancel", { action: "cancel", runId: "research-legacy" });
        expect(result.details).toMatchObject({
          found: true,
          killed: false,
          cascadeKilled: 0,
          error: expect.stringContaining("owning agent is unresolved"),
        });
      } else {
        const result = await killAllControlledSubagentRuns({
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
          status: "error",
          killed: 0,
          failed: 1,
          error: expect.stringContaining("owning agent is unresolved"),
        });
      }
      expect(getSubagentRunByRunId("research-legacy")).toEqual(before);
      expect(getSubagentRunByRunId("main-legacy")?.execution.endedAt).toBeUndefined();
      expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: "global" })).toEqual(
        sessionBefore,
      );
      expect(getExistingFollowupQueue("global", target)?.items).toContain(followup);
      expect(fixture.cleanup).not.toHaveBeenCalled();
      expect(fixture.gateway).not.toHaveBeenCalled();
    } finally {
      clearSessionQueues(["global"], target);
    }
  },
);

it.each([
  { sessionKey: "global", childAgentId: "main", bindNativeRun: true },
  { sessionKey: "agent:main:subagent:legacy", childAgentId: undefined, bindNativeRun: false },
])(
  "cancels only the legacy task on $sessionKey despite a newer owned incarnation (native=$bindNativeRun)",
  async ({ sessionKey, childAgentId, bindNativeRun }) => {
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      sessionKey,
      agentId: "main",
      defaultSessionId: "replacement",
    });
    const cfg: OpenClawConfig = { session: { store: storePath } };
    await addSubagentRunForTests({
      runId: "unbound-incarnation",
      childSessionKey: sessionKey,
      childAgentId,
      requesterSessionKey: "agent:main:main",
      childSessionIdentity: undefined,
      generation: 1,
    });
    const sessionBefore = loadSessionEntry({ agentId: "main", storePath, sessionKey });
    expect(sessionBefore).toBeDefined();
    await addSubagentRunForTests({
      runId: "next-incarnation",
      childSessionKey: sessionKey,
      childAgentId: "main",
      requesterSessionKey: "agent:main:main",
      childSessionIdentity: sessionBefore,
      generation: 2,
    });
    const legacyRun = getSubagentRunByRunId("unbound-incarnation")!;
    const nextBefore = structuredClone(getSubagentRunByRunId("next-incarnation"));
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const nativeRun = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        agentId: "main",
        incarnation: "original-session",
      }),
      runId: legacyRun.runId,
      sessionKey,
      sessionId: "original-session",
      kind: "agent",
      timeoutMs: 60_000,
    });
    const successorRun = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        agentId: "main",
        incarnation: sessionBefore!.sessionId,
      }),
      runId: "next-incarnation",
      sessionKey,
      sessionId: sessionBefore!.sessionId,
      kind: "agent",
      timeoutMs: 60_000,
    });
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
    const followup = createQueueTestRun({ prompt: "Successor's queued followup" });
    Object.assign(followup.run, {
      agentId: "main",
      sessionKey,
      sessionId: sessionBefore!.sessionId,
      config: cfg,
    });
    const target = captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId: "main",
      incarnation: sessionBefore!.sessionId,
    });
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false);
    fixture.worker.mockClear();
    try {
      expect(
        await killSubagentRunAdmin({
          cfg,
          sessionKey,
          agentId: "main",
          expectedRunId: "unbound-incarnation",
          expectedGeneration: 1,
        }),
      ).toEqual({ found: false, killed: false });
      expect(getSubagentRunByRunId("unbound-incarnation")?.execution.status).toBe("running");
      expect(
        await killSubagentRunAdmin({
          cfg,
          sessionKey,
          agentId: "main",
          expectedRunId: "unbound-incarnation",
        }),
      ).toMatchObject({
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
      expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })).toEqual(sessionBefore);
      expect(getExistingFollowupQueue(sessionKey, target)?.items).toContain(followup);
      expect(fixture.cleanup).not.toHaveBeenCalled();
      expect(fixture.gateway).not.toHaveBeenCalled();
      expect(fixture.capture).not.toHaveBeenCalled();
      expect(fixture.announce).not.toHaveBeenCalled();
      expect(fixture.wake).not.toHaveBeenCalled();
    } finally {
      clearGatewayContextResolver(legacyRun);
      nativeReleased.resolve();
      await nativeExecution;
      nativeRun.cleanup();
      successorRun.cleanup();
      clearSessionQueues([sessionKey], target);
    }
  },
);

it.each(["registration", "execution target"] as const)(
  "limits cancellation when the %s omitted the current session's lifecycle revision",
  async (identitySource) => {
    const sessionKey = "agent:main:subagent:revision-reused-id";
    const sessionId = "reused-session-id";
    const runId = "revision-fenced-run";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      sessionKey,
      agentId: "main",
      defaultSessionId: sessionId,
    });
    const scope = { agentId: "main", storePath, sessionKey };
    const lifecycleRevision = "successor-revision";
    await addSubagentRunForTests({
      runId,
      childSessionKey: sessionKey,
      childAgentId: "main",
      requesterSessionKey: "agent:main:main",
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
    const sessionBefore = loadSessionEntry(scope);
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    abort.mockImplementation(() => detachActiveEmbeddedRun(sessionId, handle, sessionKey));
    attachActiveEmbeddedRun(sessionId, handle, sessionKey, storePath, undefined, "main");
    const followup = createQueueTestRun({ prompt: "Successor's queued followup" });
    Object.assign(followup.run, {
      agentId: "main",
      sessionKey,
      sessionId,
      config: { session: { store: storePath } },
    });
    const target = captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId: "main",
      incarnation: sessionBefore!.sessionId,
    });
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false);
    fixture.worker.mockClear();
    try {
      expect(
        await killSubagentRunAdmin({
          cfg: { session: { store: storePath } },
          sessionKey,
          agentId: "main",
          expectedRunId: runId,
        }),
      ).toMatchObject({
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
      expect(loadSessionEntry(scope)).toEqual(sessionBefore);
      expect(getExistingFollowupQueue(sessionKey, target)?.items).toContain(followup);
      expect(abort).toHaveBeenCalledTimes(identitySource === "registration" ? 1 : 0);
      expect(fixture.cleanup).not.toHaveBeenCalled();
      expect(fixture.gateway).not.toHaveBeenCalled();
      expect(fixture.capture).not.toHaveBeenCalled();
      expect(fixture.announce).not.toHaveBeenCalled();
      expect(fixture.wake).not.toHaveBeenCalled();
    } finally {
      await detachActiveEmbeddedRun(sessionId, handle, sessionKey);
      clearSessionQueues([sessionKey], target);
    }
  },
);
