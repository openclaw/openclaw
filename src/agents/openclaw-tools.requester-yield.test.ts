import path from "node:path";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeInternalToolResult } from "../../packages/agent-core/src/internal-hooks.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader, type OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { addSession, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import * as persistence from "./subagents/registry/subagent-registry-persistence.js";
import { mutateSubagentRuns } from "./subagents/registry/subagent-registry-persistence.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagents/registry/subagent-requester-settle-identity.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const CRON_RUN_KEY = "agent:main:cron:daily-report:run:run-42";
const sessionDirs = useSessionStoreTempDirs(afterAll, "cron-yield-policy-");

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});

async function seedRequiredChild(
  requesterSessionKey = CRON_RUN_KEY,
  overrides: Partial<SubagentRunRecord> = {},
): Promise<SubagentRunRecord> {
  const run: SubagentRunRecord = {
    runId: "run-child",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId: "run-requester",
    task: "child work",
    cleanup: "keep",
    createdAt: 1_000,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    execution: { status: "running" },
    ...overrides,
  };
  await addSubagentRunForTests(run);
  return run;
}

function seedNativeChild(overrides: Partial<SubagentRunRecord> = {}) {
  return seedRequiredChild("agent:main:main", { requesterTurnRunId: undefined, ...overrides });
}

function sessionConfig() {
  const workspace = sessionDirs.make();
  const storePath = path.join(workspace, "sessions.json");
  return {
    storePath,
    config: {
      agents: { entries: { main: { workspace } } },
      session: { store: storePath },
      tools: { profile: "coding" },
    } satisfies OpenClawConfig,
  };
}

async function expectYield(
  tool: ReturnType<typeof createSessionsYieldTool>,
  expected: string | Record<string, unknown>,
  args: Parameters<typeof tool.execute>[1] = {},
) {
  expect((await tool.execute("yield-call", args)).details).toMatchObject(
    typeof expected === "string" ? { status: expected } : expected,
  );
}

it.each([
  {
    acknowledgment: "  PAUSE-MARKER\nneeds direction  ",
    expected: "PAUSE-MARKER\nneeds direction",
  },
  { acknowledgment: undefined, expected: "Paused awaiting continuation." },
  { acknowledgment: "x".repeat(12_001), expected: "x".repeat(12_000) },
])(
  "retains the announcing child's bounded message-wait notice (case %#)",
  async ({ acknowledgment, expected }) => {
    const child = await seedNativeChild();
    const tool = createYieldToolForTurn({
      requesterSessionKey: child.childSessionKey,
      requesterTurnRunId: child.runId,
    });
    await expectYield(tool, "yielded", { waitFor: "message", acknowledgment });
    expect(getSubagentRunByRunId(child.runId)?.requesterSettleWake?.pauseNotice).toEqual({
      acknowledgment: expected,
    });
    expect(getSubagentRunByRunId(child.runId)?.execution.status).toBe("running");
  },
);

it.each(["registry child", "runtime claim"] as const)(
  "yields for a subagent's own %s without publishing a message-wait pause notice",
  async (source) => {
    // The subagent is itself a running announced child of agent:main:main.
    const runner = await seedNativeChild({
      runId: "run-runner",
      childSessionKey: "agent:main:subagent:runner",
    });
    if (source === "registry child") {
      // ...and this turn of the subagent spawned a leaf whose completion resumes it.
      await seedRequiredChild(runner.childSessionKey, {
        runId: "run-leaf",
        childSessionKey: "agent:main:subagent:leaf",
        requesterTurnRunId: runner.runId,
      });
    }
    const onYield = vi.fn();
    const tool = createYieldToolForTurn({
      requesterSessionKey: runner.childSessionKey,
      requesterTurnRunId: runner.runId,
      ...(source === "runtime claim" ? { claimYieldCompletion: () => true } : {}),
      onYield,
    });

    await expectYield(
      tool,
      {
        status: "yielded",
        acknowledgment: "Handoff: leaf pending",
        note: expect.stringContaining('waitFor: "message" was not applied'),
      },
      { waitFor: "message", acknowledgment: "Handoff: leaf pending" },
    );
    // An ordinary child wait: no message wait is recorded for the runtime, and the
    // runner's requester is not told it is paused awaiting a sessions_send.
    expect(onYield).toHaveBeenCalledWith("Turn yielded.", "Handoff: leaf pending", undefined);
    const after = getSubagentRunByRunId(runner.runId);
    expect(after?.requesterSettleWake?.pauseNotice).toBeUndefined();
    expect(after?.execution.status).toBe("running");
  },
);

function createYieldToolForTurn({
  onYield = vi.fn(),
  ...claim
}: Omit<Parameters<typeof createRequesterYieldCallback>[0], "requesterAgentId"> & {
  onYield?: NonNullable<Parameters<typeof createSessionsYieldTool>[0]>["onYield"];
}) {
  return createSessionsYieldTool({
    sessionId: "requester-session",
    claimYield: createRequesterYieldCallback({ requesterAgentId: "main", ...claim }),
    onYield,
  });
}

function backgroundProcess(sessionKey: string, scopeKey = sessionKey) {
  const process = createProcessSessionFixture({ id: "watch-ci", backgrounded: true });
  process.sessionKey = sessionKey;
  process.scopeKey = scopeKey;
  addSession(process);
  return process;
}

function requireTool(tools: ReturnType<typeof createTestOpenClawTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.isDefined(tool);
  return tool;
}

function createTestOpenClawTools(
  options: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]> = {},
) {
  return createOpenClawCodingTools({
    ...options,
    config: {
      ...options.config,
      agents: options.config?.agents ?? { entries: { main: {} } },
    } satisfies OpenClawConfig,
    wrapBeforeToolCallHook: false,
  });
}

function watcherTool(options: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]> = {}) {
  return requireTool(
    createTestOpenClawTools({
      sessionKey: "agent:main:subagent:watcher",
      sessionId: "watcher-session",
      runId: "run-watcher",
      ...options,
    }),
    "sessions_yield",
  );
}

describe("requester yield ownership", () => {
  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    resetProcessRegistryForTests();
  });
  afterEach(async () => {
    await resetSubagentRegistryForTests();
    resetProcessRegistryForTests();
  });

  it.each([["agent:main:subagent:collector", true, "collected explicitly"]] as const)(
    "rejects %s before claim, intent, or yield",
    async (requesterSessionKey, swarmCollector, error) => {
      await seedRequiredChild(requesterSessionKey);
      const before = structuredClone(getSubagentRunByRunId("run-child"));
      const runtimeClaim = vi.fn(() => true);
      const onYield = vi.fn();
      const tool = createYieldToolForTurn({
        requesterSessionKey,
        requesterTurnRunId: "run-requester",
        swarmCollector,
        claimYieldCompletion: runtimeClaim,
        onYield,
      });

      await expectYield(tool, { status: "error", error: expect.stringContaining(error) });
      expect(runtimeClaim).not.toHaveBeenCalled();
      expect(onYield).not.toHaveBeenCalled();
      expect(getSubagentRunByRunId("run-child")).toEqual(before);
    },
  );

  it.each([
    { kind: "visible child", key: "dashboard:visible", child: true },
    { kind: "hidden child", key: "subagent:hidden", child: true },
    { kind: "dashboard root", key: "dashboard:root", child: false },
  ])("uses native task ownership for $kind message waits", async ({ key, child }) => {
    const { config, storePath } = sessionConfig();
    const sessionKey = "agent:main:" + key;
    const runId = "envelope-run";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "envelope-session",
        updatedAt: 1,
        parentSessionKey: "agent:main:main",
        ...(child
          ? { spawnedBy: "agent:main:main", spawnDepth: 1, inheritedToolPolicyVersion: 1 }
          : {}),
      },
    );
    if (child) {
      await seedNativeChild({
        runId,
        childSessionKey: sessionKey,
        childAgentId: "main",
      });
    }
    const onYield = vi.fn();
    const tools = createTestOpenClawTools({
      config,
      sessionKey,
      sessionId: "envelope-session",
      runId,
      onYield,
    });
    await expectYield(requireTool(tools, "sessions_yield"), child ? "yielded" : "nothing_pending", {
      waitFor: "message",
    });
    expect(tools.some((tool) => tool.name === "sessions_send")).toBe(!child);
    if (child) {
      expect(onYield).toHaveBeenCalledWith("Turn yielded.", undefined, true);
      expect(getSubagentRunByRunId(runId)?.requesterSettleWake?.pauseNotice).toBeDefined();
    } else {
      expect(onYield).not.toHaveBeenCalled();
    }
  });

  it.each(["missing", "terminal", "stopped", "collector", "foreign-agent"] as const)(
    "rejects an ineligible %s message wait",
    async (kind) => {
      const sessionKey = "agent:main:subagent:invalid";
      if (kind !== "missing") {
        await seedNativeChild({
          runId: "invalid",
          childSessionKey: sessionKey,
          childAgentId: kind === "foreign-agent" ? "peer" : "main",
          ...(kind === "terminal"
            ? { execution: { status: "terminal", endedAt: 2000, outcome: { status: "ok" } } }
            : {}),
          ...(kind === "stopped" ? { suppressCompletionDelivery: true } : {}),
          ...(kind === "collector" ? { collect: true } : {}),
        });
      }
      const onYield = vi.fn();
      const tool = createYieldToolForTurn({
        requesterSessionKey: sessionKey,
        requesterTurnRunId: "invalid",
        onYield,
      });
      await expectYield(tool, "nothing_pending", { waitFor: "message" });
      expect(onYield).not.toHaveBeenCalled();
    },
  );

  it.each(["main", "peer"])(
    "scopes an existing task successor to agent %s",
    async (successorAgent) => {
      const child = await seedNativeChild({
        generation: 1,
        taskRunId: "logical-task",
        childAgentId: "main",
      });
      await seedNativeChild({
        runId: "successor",
        generation: 2,
        childSessionKey: child.childSessionKey,
        childAgentId: successorAgent,
        taskRunId: child.taskRunId,
      });
      const onYield = vi.fn();
      const tool = createYieldToolForTurn({
        requesterSessionKey: child.childSessionKey,
        requesterTurnRunId: child.runId,
        onYield,
      });
      const accepted = successorAgent !== "main";
      await expectYield(tool, accepted ? "yielded" : "nothing_pending", { waitFor: "message" });
      if (accepted) {
        expect(onYield).toHaveBeenCalledWith("Turn yielded.", undefined, true);
      } else {
        expect(onYield).not.toHaveBeenCalled();
      }
      expect(Boolean(getSubagentRunByRunId(child.runId)?.requesterSettleWake?.pauseNotice)).toBe(
        accepted,
      );
    },
  );

  it.each(
    (["before commit", "after commit", "quiet before plan", "quiet after plan"] as const).flatMap(
      (phase) => [true, false].map((sameTask) => ({ phase, sameTask })),
    ),
  )("rechecks native ownership $phase (same task: $sameTask)", async ({ phase, sameTask }) => {
    const quiet = phase.startsWith("quiet");
    const child = await seedNativeChild({
      childAgentId: "main",
      taskRunId: "logical-task",
      generation: 1,
      expectsCompletionMessage: !quiet,
      completion: { required: !quiet },
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let held = false;
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    const mutate = persistence.mutateSubagentRuns;
    const barrier = quiet
      ? vi.spyOn(persistence, "mutateSubagentRuns").mockImplementation(async (...args) => {
          if (held || !args[0].includes(child.runId)) {
            return mutate(...args);
          }
          held = true;
          if (phase === "quiet before plan") {
            await hold();
            return mutate(...args);
          }
          const result = await mutate(...args);
          await hold();
          return result;
        })
      : vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementation((context, run, options) =>
            runWorker(
              context,
              (scope) =>
                run({
                  ...scope,
                  execute: async (command, executeOptions) => {
                    const selected = command.type === "subagents.persistChanges" && !held;
                    if (selected) {
                      held = true;
                    }
                    if (selected && phase === "before commit") {
                      await hold();
                    }
                    const result = await scope.execute(command, executeOptions);
                    if (selected && phase === "after commit") {
                      await hold();
                    }
                    return result;
                  },
                }),
              options,
            ),
          );
    const onYield = vi.fn();
    const yielding = createYieldToolForTurn({
      requesterSessionKey: child.childSessionKey,
      requesterTurnRunId: child.runId,
      onYield,
    }).execute("yield-await", { waitFor: "message" });
    void yielding.catch(() => {});
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        yielding,
        "yield did not reach its owner barrier",
      );
      await seedNativeChild({
        runId: "newer-run",
        childSessionKey: child.childSessionKey,
        childAgentId: "main",
        taskRunId: sameTask ? child.taskRunId : undefined,
        generation: 2,
      });
      release.resolve();
      if (sameTask) {
        await expect(yielding).rejects.toThrow("current native task");
        expect(onYield).not.toHaveBeenCalled();
      } else {
        expect((await yielding).details).toMatchObject({ status: "yielded" });
        expect(onYield).toHaveBeenCalledWith("Turn yielded.", undefined, !quiet);
      }
      // A known commit stays published even when a newer task invalidates the caller.
      // No-write quiet claims and refused pre-commit grants never create a notice.
      expect(Boolean(getSubagentRunByRunId(child.runId)?.requesterSettleWake?.pauseNotice)).toBe(
        !quiet && (!sameTask || phase === "after commit"),
      );
    } finally {
      release.resolve();
      await Promise.allSettled([yielding]);
      barrier.mockRestore();
    }
  });

  it("ends the automation execution and leaves child delivery scheduler-owned", async () => {
    await seedRequiredChild();
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const onYield = vi.fn();
    const tools = createTestOpenClawTools({
      sessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: CRON_RUN_KEY,
      sessionId: "cron-requester-session",
      runId: "run-requester",
      onYield,
    });

    await expectYield(requireTool(tools, "sessions_yield"), "yielded");
    expect(onYield).toHaveBeenCalledExactlyOnceWith("Turn yielded.", undefined, undefined);
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });

  it.each([
    ["agent:main:subagent:watcher", undefined, undefined],
    ["agent:main:main", "agent:main:subagent:watcher", "worker-process-scope"],
  ])(
    "keeps a subagent active until its background exec result is collected (%s/%s/%s)",
    async (controllerKey, runKey, scopeKey) => {
      const sessionKey = runKey ?? controllerKey;
      await seedNativeChild({
        runId: "run-watcher",
        childSessionKey: sessionKey,
      });
      const process = backgroundProcess(sessionKey, scopeKey);
      const onYield = vi.fn();
      const tools = createTestOpenClawTools({
        sessionKey: controllerKey,
        runSessionKey: runKey,
        exec: { scopeKey },
        sessionId: "watcher-session",
        runId: "run-watcher",
        onYield,
      });
      const yieldTool = requireTool(tools, "sessions_yield");
      const processTool = requireTool(tools, "process");
      const expectStillActive = async () => {
        for (const waitFor of [undefined, "message"] as const) {
          await expectYield(
            yieldTool,
            {
              status: "error",
              error: expect.stringContaining("Use process to poll and collect"),
            },
            { waitFor },
          );
        }
        expect(onYield).not.toHaveBeenCalled();
      };

      await expectStillActive();
      markExited(process, 2, null, "failed");
      delete process.sessionKey;
      await expectStillActive();
      const result = await processTool.execute("poll-watcher", {
        action: "poll",
        sessionId: process.id,
      });
      await expectStillActive();
      acknowledgeInternalToolResult(result);
      await expectYield(yieldTool, "nothing_pending");
      expect(onYield).not.toHaveBeenCalled();
      await expectYield(yieldTool, "yielded", { waitFor: "message" });
      expect(onYield).toHaveBeenCalledOnce();
    },
  );

  it.each(["running", "finished"])(
    "ignores another session's %s background exec for subagent self-yield",
    async (state) => {
      await seedNativeChild({
        runId: "run-watcher",
        childSessionKey: "agent:main:subagent:watcher",
      });
      const process = backgroundProcess("agent:main:subagent:other");
      if (state === "finished") {
        markExited(process, 2, null, "failed");
        delete process.sessionKey;
      }
      const onYield = vi.fn();
      const tool = watcherTool({ onYield });

      await expectYield(tool, "yielded", { waitFor: "message" });
      expect(onYield).toHaveBeenCalledOnce();
    },
  );

  it("preserves a runtime completion claim with an owned background exec", async () => {
    const sessionKey = "agent:main:subagent:watcher";
    backgroundProcess(sessionKey);
    const onYield = vi.fn();
    const tool = watcherTool({
      sessionKey,
      runId: "run-requester",
      claimYieldCompletion: () => true,
      onYield,
    });

    await expectYield(tool, "yielded");
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("checks background exec after an awaited runtime completion claim", async () => {
    const sessionKey = "agent:main:subagent:watcher";
    await seedNativeChild({
      runId: "run-watcher",
      childSessionKey: sessionKey,
    });
    const onYield = vi.fn();
    const tool = watcherTool({
      sessionKey,
      claimYieldCompletion: async () => {
        await Promise.resolve();
        backgroundProcess(sessionKey);
        return false;
      },
      onYield,
    });

    await expectYield(tool, {
      status: "error",
      error: expect.stringContaining("Use process to poll and collect"),
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    { policy: { profile: "coding" as const }, runtime: undefined, allowed: true },
    { policy: { profile: "coding" as const }, runtime: ["read", "sessions_spawn"], allowed: false },
  ])(
    "preserves child yield authorization under $policy / $runtime",
    async ({ policy, runtime, allowed }) => {
      const { config, storePath } = sessionConfig();
      const inheritedToolAllowlistRef: string[] = [];
      const parent = createTestOpenClawTools({
        config: { ...config, tools: policy },
        sessionKey: CRON_RUN_KEY,
        inheritedToolAllowlistRef,
        runtimeToolAllowlist: runtime,
        inheritRuntimeToolAllowlist: true,
      });
      expect(parent.some((tool) => tool.name === "sessions_yield")).toBe(allowed);
      expect(inheritedToolAllowlistRef.includes("sessions_yield")).toBe(allowed);
      const childSessionKey = "agent:main:subagent:policy-child";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: childSessionKey, storePath },
        {
          sessionId: "policy-child",
          updatedAt: 1000,
          spawnedBy: CRON_RUN_KEY,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: inheritedToolAllowlistRef,
        },
      );
      const child = createTestOpenClawTools({
        config: { ...config, tools: { profile: "coding" } },
        sessionKey: childSessionKey,
      });
      expect(child.some((tool) => tool.name === "sessions_yield")).toBe(allowed);
    },
  );

  it("resumes a later turn truthfully after an earlier turn spawned and yielded", async () => {
    const requesterSessionKey = "agent:main:dashboard:coordination";
    const child = await seedRequiredChild(requesterSessionKey, {
      childSessionKey: "agent:main:dashboard:work",
      label: "Work session",
      requesterTurnRunId: "run-turn-1",
      execution: { status: "running", startedAt: 2_000 },
    });
    // Turn 1 spawns the visible child and yields for it.
    const turn1Yield = vi.fn();
    const turn1 = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: "run-turn-1",
      onYield: turn1Yield,
    });
    await expectYield(turn1, "yielded");
    expect(turn1Yield).toHaveBeenCalledOnce();
    expect(
      await settleRequesterAfterSessionSpawns({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: "run-turn-1",
        requesterYielded: true,
        acceptedSessionSpawns: [
          {
            runId: child.runId,
            childSessionKey: child.childSessionKey,
            expectsCompletionMessage: true,
          },
        ],
      }),
    ).toBe(true);
    const settled = getSubagentRunByRunId(child.runId);
    expect(settled?.requesterTurnRunId).toBeUndefined();
    expect(settled?.requesterSettleWake).toMatchObject({ requesterYieldBatch: true });

    // Turn 2 (a new human message) owns no claim, but the child still runs.
    const turn2Yield = vi.fn();
    const turn2 = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: "run-turn-2",
      onYield: turn2Yield,
    });
    for (const waitFor of [undefined, "message"] as const) {
      const result = await turn2.execute("yield-turn-2", { waitFor });
      expect(result.details).toMatchObject({
        status: "already_pending",
        message: expect.stringContaining("already yielded for 1 child session"),
        pendingChildren: [
          {
            runId: child.runId,
            childSessionKey: "agent:main:dashboard:work",
            state: "running",
            wakeArmed: true,
          },
        ],
      });
    }
    expect(turn2Yield).not.toHaveBeenCalled();
    // Reporting must not disturb the armed wake or claim the child for turn 2.
    expect(getSubagentRunByRunId(child.runId)).toEqual(settled);

    // The completion owner stays dispatching until its requester continuation returns.
    assert(settled?.requesterSettleWake);
    await mutateSubagentRuns([child.runId], (rows) => {
      const current = rows.get(child.runId);
      assert(current?.requesterSettleWake);
      const terminal: SubagentRunRecord = {
        ...current,
        execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
      };
      return { value: undefined, postimages: new Map([[child.runId, terminal]]) };
    });
    const wakeIdentity = {
      requesterSessionKey,
      requesterAgentId: "main",
      batchRunIds: [child.runId],
      rearmGeneration: settled.requesterSettleWake.rearmGeneration,
    };
    const currentWakeRunId = buildRequesterSettleWakeIdentity(wakeIdentity).runId;
    const beforeContinuation = structuredClone(getSubagentRunByRunId(child.runId));
    const continuation = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: currentWakeRunId,
      onYield: turn2Yield,
    });
    await expectYield(continuation, "nothing_pending");
    const wrongGeneration = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: buildRequesterSettleWakeIdentity({
        ...wakeIdentity,
        rearmGeneration: (wakeIdentity.rearmGeneration ?? 0) + 1,
      }).runId,
    });
    await expectYield(wrongGeneration, {
      status: "already_pending",
      pendingChildren: [{ runId: child.runId }],
    });
    await seedRequiredChild(requesterSessionKey, {
      runId: "unrelated-child",
      childSessionKey: "agent:main:subagent:unrelated",
      requesterTurnRunId: "another-turn",
    });
    await expectYield(continuation, {
      status: "already_pending",
      pendingChildren: [{ runId: "unrelated-child" }],
    });
    expect(turn2Yield).not.toHaveBeenCalled();
    expect(getSubagentRunByRunId(child.runId)).toEqual(beforeContinuation);
  });

  it.each([false, true])("reports earlier-turn children (native: %s)", async (native) => {
    const requesterSessionKey = "agent:main:main";
    await seedRequiredChild(requesterSessionKey, { requesterTurnRunId: undefined });
    const nativeChild = {
      runId: "codex-thread:native-child",
      childSessionKey: "codex-thread:native-child",
      state: "running" as const,
      wakeArmed: false,
    };
    const onYield = vi.fn();
    const tool = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: "run-turn-2",
      ...(native ? { claimYieldCompletion: () => ({ pendingChildren: [nativeChild] }) } : {}),
      onYield,
    });
    expect((await tool.execute("yield-turn-2", {})).details).toMatchObject({
      status: "already_pending",
      message: expect.stringContaining(
        `already spawned ${native ? "2 child sessions" : "1 child session"}`,
      ),
      pendingChildren: [
        ...(native ? [nativeChild] : []),
        { runId: "run-child", state: "running", ...(!native ? { wakeArmed: false } : {}) },
      ],
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("does not persist or yield after a runtime claim failure", async () => {
    await seedRequiredChild("agent:main:main");
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const onYield = vi.fn();
    const tool = createYieldToolForTurn({
      requesterSessionKey: "agent:main:main",
      requesterTurnRunId: "run-requester",
      claimYieldCompletion: () => {
        throw new Error("runtime claim failed");
      },
      onYield,
    });
    await expect(tool.execute("yield-call", {})).rejects.toThrow("runtime claim failed");
    expect(onYield).not.toHaveBeenCalled();
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });
});
