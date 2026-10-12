// The shared fixture installs registry mocks before these consumers are evaluated.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { enqueueFollowupRun } from "../../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../../auto-reply/reply/queue/state.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { clearCommandLane, enqueueCommandInLane } from "../../../process/command-queue.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { AgentSelectionRequiredError, resolveSessionAgentId } from "../../agent-scope.js";
import { resolveEmbeddedSessionLane } from "../../embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import type { AgentToolGatewayRequestCaller } from "../../tools/in-process-gateway.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { captureSubagentCompletionReply } from "../announce/subagent-announce-output.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { getSubagentRunByRunId } from "./subagent-registry.test-helpers.js";

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
  expect(sent.details).toMatchObject({ status: "accepted", watched: true });
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
  setActiveEmbeddedRun(foreignId, foreignHandle, "global", undefined, foreignAgent);
  const followup = createQueueTestRun({ prompt: "Other agent's queued followup" });
  Object.assign(followup.run, {
    agentId: foreignAgent,
    sessionKey: "global",
    sessionId: foreignId,
  });
  enqueueFollowupRun("global", followup, { mode: "followup" }, "none", undefined, false);
  const lane = resolveEmbeddedSessionLane("global");
  const entered = createDeferred();
  const release = createDeferred();
  const blocker = enqueueCommandInLane(lane, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const foreignCommand = enqueueCommandInLane(lane, async () => "foreign command survived", {
    sessionTarget: { agentId: foreignAgent, sessionKey: "global", sessionId: foreignId },
  });
  const childCommand = enqueueCommandInLane(lane, async () => "child must not start", {
    sessionTarget: { agentId: owner, sessionKey: "global", sessionId: childId },
  });
  const outcome = Promise.allSettled([foreignCommand, childCommand]);
  const interruptChild = vi.fn(() => childAdmission.release());
  const childAdmission = await beginSessionWorkAdmission({
    scope: childStorePath,
    identities: ["global", childId],
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
    expect.soft(getExistingFollowupQueue("global")?.items.includes(followup) ?? false).toBe(true);
    release.resolve();
    await blocker;
    const [foreignResult, childResult] = await outcome;
    expect.soft(foreignResult).toEqual({ status: "fulfilled", value: "foreign command survived" });
    expect(childResult).toMatchObject({
      status: "rejected",
      reason: { name: "CommandLaneClearedError" },
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
    release.resolve();
    clearCommandLane(lane);
    clearFollowupQueue("global");
    clearActiveEmbeddedRun(foreignId, foreignHandle, "global");
    await Promise.allSettled([blocker, outcome]);
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
        { message: { role: "assistant", content: `${agentId}'s partial result` } },
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
    terminal.resolve({ status: "timeout", startedAt: entry.createdAt, endedAt: Date.now() });
    const waitIndex = waits.mock.calls.findIndex(([waitingRunId]) => waitingRunId === runId);
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    await waits.mock.results[waitIndex]!.value;
    await fixture.settle();
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
  setActiveEmbeddedRun("main-global", handle, "global", undefined, "main");
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
    clearActiveEmbeddedRun("main-global", handle, "global");
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

it.each(["admin", "bulk"] as const)(
  "%s cancellation keeps legacy raw children separated by requester agent",
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
      await registerSubagentRun({
        runId: `${owner}-legacy`,
        childSessionKey: "global",
        requesterSessionKey: `agent:${owner}:main`,
        requesterAgentId: owner,
        requesterDisplayKey: owner,
        task: `${owner} work`,
        cleanup: "keep",
      });
    }
    const research = getSubagentRunByRunId("research-legacy")!;
    expect(research.childAgentId).toBeUndefined();
    expect(getSubagentRunByRunId("main-legacy")?.childAgentId).toBeUndefined();

    if (action === "admin") {
      const result = await killSubagentRunAdmin({ cfg, sessionKey: "global", agentId: "research" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ found: true, killed: true, runId: "research-legacy" });
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
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ status: "ok", killed: 1 });
    }
    expect(getSubagentRunByRunId("research-legacy")?.execution.endedAt).toBeTypeOf("number");
    expect(getSubagentRunByRunId("main-legacy")?.execution.endedAt).toBeUndefined();
  },
);
