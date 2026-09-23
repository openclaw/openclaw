import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { addSession, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import { markRequesterTurnYieldedInRuns } from "./subagents/registry/subagent-registry-requester-yield.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const CRON_RUN_KEY = "agent:main:cron:daily-report:run:run-42";

function seedRequiredChild(
  requesterSessionKey = CRON_RUN_KEY,
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
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
  addSubagentRunForTests(run);
  return run;
}

const GENERIC_NO_CLAIM_ERROR = expect.stringContaining("return its result normally");

function createYieldToolForTurn(params: {
  requesterSessionKey: string;
  requesterTurnRunId?: string;
  onYield?: NonNullable<Parameters<typeof createSessionsYieldTool>[0]>["onYield"];
}) {
  return createSessionsYieldTool({
    sessionId: "requester-session",
    claimYield: createRequesterYieldCallback({
      requesterSessionKey: params.requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId: params.requesterTurnRunId,
    }),
    onYield: params.onYield ?? vi.fn(),
  });
}

function createTestOpenClawTools(
  options: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]> = {},
) {
  return createOpenClawCodingTools({
    ...options,
    config: {
      ...options.config,
      agents: options.config?.agents ?? { entries: { main: { default: true } } },
    } satisfies OpenClawConfig,
    wrapBeforeToolCallHook: false,
  });
}

describe("requester yield ownership", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetProcessRegistryForTests();
  });
  afterEach(() => {
    resetSubagentRegistryForTests();
    resetProcessRegistryForTests();
  });

  it("models an owned child the old cron claim could mark", () => {
    const childRun = seedRequiredChild();
    const marked = markRequesterTurnYieldedInRuns({
      requesterSessionKey: CRON_RUN_KEY,
      requesterAgentId: "main",
      requesterTurnRunId: "run-requester",
      runs: new Map([[childRun.runId, childRun]]),
      persistOrThrow: () => {},
    });

    expect(marked).toBe(1);
    expect(childRun.requesterTurnYielded).toBe(true);
  });

  it.each([CRON_RUN_KEY, "agent:main:cron:daily-report"])(
    "rejects %s before runtime claim, durable intent, or runtime yield",
    async (requesterSessionKey) => {
      seedRequiredChild(requesterSessionKey);
      const before = structuredClone(getSubagentRunByRunId("run-child"));
      const runtimeClaim = vi.fn(() => true);
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "requester-session",
        claimYield: createRequesterYieldCallback({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: "run-requester",
          claimYieldCompletion: runtimeClaim,
        }),
        onYield,
      });

      const result = await tool.execute("yield-call", {});

      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("no requester continuation"),
      });
      expect(runtimeClaim).not.toHaveBeenCalled();
      expect(onYield).not.toHaveBeenCalled();
      expect(getSubagentRunByRunId("run-child")).toEqual(before);
    },
  );

  it("rejects a cron requester without another claim source", async () => {
    const claim = createRequesterYieldCallback({
      requesterSessionKey: CRON_RUN_KEY,
      requesterAgentId: "main",
    });
    expect(await claim?.()).toEqual({
      error: expect.stringContaining("no requester continuation"),
    });
  });

  it("omits yield for the execution identity and leaves its child owned", () => {
    seedRequiredChild();
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const tools = createTestOpenClawTools({
      sessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: CRON_RUN_KEY,
      sessionId: "cron-requester-session",
      runId: "run-requester",
      onYield: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });

  it("omits yield when only the controller identity is cron", () => {
    const tools = createTestOpenClawTools({
      sessionKey: "agent:main:cron:daily-report",
      sessionId: "cron-controller-session",
      runId: "run-requester",
    });
    expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");
  });

  it.each([
    "agent:main:telegram:default:direct:1234",
    "agent:main:subagent:worker",
    "agent:main:main",
  ])("preserves assembled owned yield for %s", async (agentSessionKey) => {
    seedRequiredChild(agentSessionKey);
    const onYield = vi.fn(() => {
      expect(getSubagentRunByRunId("run-child")?.requesterTurnYielded).toBe(true);
    });
    const tool = createTestOpenClawTools({
      sessionKey: agentSessionKey,
      sessionId: "requester-session",
      runId: "run-requester",
      onYield,
    }).find((candidate) => candidate.name === "sessions_yield");
    assert.isDefined(tool);

    expect((await tool.execute("yield-call", {})).details).toMatchObject({ status: "yielded" });
    expect(onYield).toHaveBeenCalledOnce();
  });

  it.each([
    { requesterSessionKey: "agent:main:main", runtimeClaim: true, accepted: true },
    { requesterSessionKey: "agent:main:subagent:worker", runtimeClaim: false, accepted: false },
    {
      requesterSessionKey: "agent:main:subagent:worker",
      runtimeClaim: false,
      waitFor: "message",
      accepted: true,
    },
    {
      requesterSessionKey: "agent:main:main",
      runtimeClaim: false,
      waitFor: "message",
      accepted: false,
    },
    { requesterSessionKey: CRON_RUN_KEY, runtimeClaim: true, waitFor: "message", accepted: false },
    { requesterSessionKey: "agent:main:main", runtimeClaim: false, accepted: false },
  ])(
    "preserves claim without a registry child: $requesterSessionKey/$runtimeClaim",
    async (test) => {
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "requester-session",
        claimYield: createRequesterYieldCallback({
          requesterSessionKey: test.requesterSessionKey,
          requesterAgentId: "main",
          claimYieldCompletion: () => test.runtimeClaim,
        }),
        onYield,
      });
      expect((await tool.execute("yield-call", { waitFor: test.waitFor })).details).toMatchObject({
        status: test.accepted ? "yielded" : "error",
      });
      expect(onYield).toHaveBeenCalledTimes(test.accepted ? 1 : 0);
    },
  );

  it("keeps a completed worker active so it can return its result instead of stranding the task", async () => {
    const onYield = vi.fn();
    const tool = createTestOpenClawTools({
      sessionKey: "agent:main:subagent:finished-worker",
      sessionId: "finished-worker-session",
      runId: "finished-worker-run",
      onYield,
    }).find((candidate) => candidate.name === "sessions_yield");
    assert.isDefined(tool);
    const result = await tool.execute("yield-completed-command", {
      message:
        "The assigned command completed and returned RESULT_17; process list has no active sessions.",
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("return its result normally"),
    });
    expect(onYield).not.toHaveBeenCalled();
    expect(
      (
        await tool.execute("wait-for-incoming-message", {
          waitFor: "message",
          message: "Wait for an operator continuation.",
        })
      ).details,
    ).toMatchObject({ status: "yielded" });
    expect(onYield).toHaveBeenCalledExactlyOnceWith(
      "Wait for an operator continuation.",
      undefined,
    );
  });

  it.each([
    {
      label: "session scope",
      controllerKey: "agent:main:subagent:watcher",
      runKey: undefined,
      scopeKey: undefined,
    },
    {
      label: "split execution session",
      controllerKey: "agent:main:main",
      runKey: "agent:main:subagent:watcher",
      scopeKey: undefined,
    },
    {
      label: "explicit process scope",
      controllerKey: "agent:main:main",
      runKey: "agent:main:subagent:watcher",
      scopeKey: "worker-process-scope",
    },
  ])(
    "keeps a subagent active until its background exec result is collected ($label)",
    async ({ controllerKey, runKey, scopeKey }) => {
      const sessionKey = runKey ?? controllerKey;
      const process = createProcessSessionFixture({ id: "watch-ci", backgrounded: true });
      process.sessionKey = sessionKey;
      process.scopeKey = scopeKey ?? sessionKey;
      addSession(process);
      const onYield = vi.fn();
      const tools = createTestOpenClawTools({
        sessionKey: controllerKey,
        runSessionKey: runKey,
        exec: { scopeKey },
        sessionId: "watcher-session",
        runId: "run-watcher",
        onYield,
      });
      const yieldTool = tools.find((tool) => tool.name === "sessions_yield");
      const processTool = tools.find((tool) => tool.name === "process");
      assert.isDefined(yieldTool);
      assert.isDefined(processTool);
      const expectStillActive = async () => {
        for (const waitFor of [undefined, "message"] as const) {
          expect((await yieldTool.execute("yield-watcher", { waitFor })).details).toMatchObject({
            status: "error",
            error: expect.stringContaining("Use process to poll and collect"),
          });
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
      expect((await yieldTool.execute("yield-collected", {})).details).toMatchObject({
        status: "error",
        error: expect.stringContaining("return its result normally"),
      });
      expect(
        (await yieldTool.execute("yield-collected-message", { waitFor: "message" })).details,
      ).toMatchObject({
        status: "yielded",
      });
      expect(onYield).toHaveBeenCalledOnce();
    },
  );

  it.each(["running", "finished"])(
    "ignores another session's %s background exec for subagent self-yield",
    async (state) => {
      const process = createProcessSessionFixture({ id: "other-command", backgrounded: true });
      process.sessionKey = "agent:main:subagent:other";
      process.scopeKey = process.sessionKey;
      addSession(process);
      if (state === "finished") {
        markExited(process, 2, null, "failed");
        delete process.sessionKey;
      }
      const onYield = vi.fn();
      const tool = createTestOpenClawTools({
        sessionKey: "agent:main:subagent:watcher",
        sessionId: "watcher-session",
        runId: "run-watcher",
        onYield,
      }).find((candidate) => candidate.name === "sessions_yield");
      assert.isDefined(tool);

      expect((await tool.execute("yield-watcher", { waitFor: "message" })).details).toMatchObject({
        status: "yielded",
      });
      expect(onYield).toHaveBeenCalledOnce();
    },
  );

  it.each(["registry", "runtime"])(
    "preserves a %s completion claim with an owned background exec",
    async (owner) => {
      const sessionKey = "agent:main:subagent:watcher";
      const process = createProcessSessionFixture({ id: "watch-ci", backgrounded: true });
      process.sessionKey = sessionKey;
      process.scopeKey = sessionKey;
      addSession(process);
      if (owner === "registry") {
        seedRequiredChild(sessionKey);
      }
      const onYield = vi.fn();
      const tool = createTestOpenClawTools({
        sessionKey,
        sessionId: "watcher-session",
        runId: "run-requester",
        claimYieldCompletion: () => owner === "runtime",
        onYield,
      }).find((candidate) => candidate.name === "sessions_yield");
      assert.isDefined(tool);

      expect((await tool.execute("yield-watcher", {})).details).toMatchObject({
        status: "yielded",
      });
      expect(onYield).toHaveBeenCalledOnce();
    },
  );

  it("checks background exec after an awaited runtime completion claim", async () => {
    const sessionKey = "agent:main:subagent:watcher";
    const onYield = vi.fn();
    const tool = createTestOpenClawTools({
      sessionKey,
      sessionId: "watcher-session",
      runId: "run-watcher",
      claimYieldCompletion: async () => {
        await Promise.resolve();
        const process = createProcessSessionFixture({ id: "watch-ci", backgrounded: true });
        process.sessionKey = sessionKey;
        process.scopeKey = sessionKey;
        addSession(process);
        return false;
      },
      onYield,
    }).find((candidate) => candidate.name === "sessions_yield");
    assert.isDefined(tool);

    expect((await tool.execute("yield-watcher", {})).details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Use process to poll and collect"),
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    { name: "with a registry turn", requesterTurnRunId: "run-collector-turn" },
    { name: "without a registry turn", requesterTurnRunId: undefined },
  ])("rejects a swarm collector yield $name", async ({ requesterTurnRunId }) => {
    seedRequiredChild("agent:main:subagent:collector");
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const runtimeClaim = vi.fn(() => true);
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "collector-session",
      claimYield: createRequesterYieldCallback({
        requesterSessionKey: "agent:main:subagent:collector",
        requesterAgentId: "main",
        requesterTurnRunId,
        swarmCollector: true,
        claimYieldCompletion: runtimeClaim,
      }),
      onYield,
    });

    expect((await tool.execute("yield-call", {})).details).toMatchObject({
      status: "error",
      error: expect.stringContaining("collected explicitly"),
    });
    // A collector owns no requester continuation, so no claim source may admit
    // its yield or record durable intent against a child row.
    expect(runtimeClaim).not.toHaveBeenCalled();
    expect(onYield).not.toHaveBeenCalled();
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });

  it.each([
    { policy: { profile: "coding" as const }, runtime: undefined, allowed: true },
    {
      policy: { profile: "coding" as const, deny: ["sessions_yield"] },
      runtime: undefined,
      allowed: false,
    },
    { policy: { allow: ["read", "sessions_spawn"] }, runtime: undefined, allowed: false },
    { policy: { profile: "coding" as const }, runtime: ["read", "sessions_spawn"], allowed: false },
  ])(
    "preserves child yield authorization under $policy / $runtime",
    async ({ policy, runtime, allowed }) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cron-yield-policy-"));
      try {
        const storePath = path.join(workspace, "sessions.json");
        const config: OpenClawConfig = {
          agents: { entries: { main: { default: true, workspace } } },
          session: { store: storePath },
          tools: policy,
        };
        const inheritedToolAllowlistRef: string[] = [];
        const parent = createTestOpenClawTools({
          config,
          sessionKey: CRON_RUN_KEY,
          inheritedToolAllowlistRef,
          runtimeToolAllowlist: runtime,
          inheritRuntimeToolAllowlist: true,
        });
        expect(parent.map((tool) => tool.name)).not.toContain("sessions_yield");
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
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("resumes a later turn truthfully after an earlier turn spawned and yielded", async () => {
    const requesterSessionKey = "agent:main:dashboard:coordination";
    const child = seedRequiredChild(requesterSessionKey, {
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
    expect((await turn1.execute("yield-turn-1", {})).details).toMatchObject({ status: "yielded" });
    expect(turn1Yield).toHaveBeenCalledOnce();
    expect(
      settleRequesterAfterSessionSpawns({
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
    expect(settled?.requesterSettleWake).toMatchObject({
      status: "pending",
      requesterYieldBatch: true,
    });

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
            label: "Work session",
            startedAt: 2_000,
            state: "running",
            wakeArmed: true,
          },
        ],
      });
      expect((result.details as { message: string }).message).toContain(
        "Work session (agent:main:dashboard:work), running, started 1970-01-01T00:00:02.000Z",
      );
      expect((result.details as { message: string }).message).toContain(
        "do not re-spawn, re-send, or poll",
      );
      expect((result.details as { message: string }).message).not.toContain(
        "return its result normally",
      );
    }
    expect(turn2Yield).not.toHaveBeenCalled();
    // Reporting must not disturb the armed wake or claim the child for turn 2.
    expect(getSubagentRunByRunId(child.runId)).toEqual(settled);
  });

  it("reports a child an earlier turn spawned without yielding", async () => {
    const requesterSessionKey = "agent:main:main";
    seedRequiredChild(requesterSessionKey, { requesterTurnRunId: undefined });
    const onYield = vi.fn();
    const tool = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: "run-turn-2",
      onYield,
    });
    expect((await tool.execute("yield-turn-2", {})).details).toMatchObject({
      status: "already_pending",
      message: expect.stringContaining("already spawned 1 child session"),
      pendingChildren: [{ runId: "run-child", state: "running", wakeArmed: false }],
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("keeps the generic error when the session has no unsettled child", async () => {
    const requesterSessionKey = "agent:main:main";
    seedRequiredChild(requesterSessionKey, {
      requesterTurnRunId: undefined,
      execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
      delivery: { status: "delivered" },
    });
    const onYield = vi.fn();
    const tool = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: "run-turn-2",
      onYield,
    });
    expect((await tool.execute("yield-turn-2", {})).details).toMatchObject({
      status: "error",
      error: GENERIC_NO_CLAIM_ERROR,
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("keeps explicit message intent for a subagent whose earlier turn still waits", async () => {
    const requesterSessionKey = "agent:main:subagent:orchestrator";
    seedRequiredChild(requesterSessionKey, { requesterTurnRunId: undefined });
    const onYield = vi.fn();
    const tool = createYieldToolForTurn({
      requesterSessionKey,
      requesterTurnRunId: "run-turn-2",
      onYield,
    });
    expect((await tool.execute("yield-no-intent", {})).details).toMatchObject({
      status: "already_pending",
      pendingChildren: [{ runId: "run-child" }],
    });
    expect(onYield).not.toHaveBeenCalled();
    expect((await tool.execute("yield-message", { waitFor: "message" })).details).toMatchObject({
      status: "yielded",
    });
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("does not persist or yield after a runtime claim failure", async () => {
    seedRequiredChild("agent:main:main");
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "requester-session",
      claimYield: createRequesterYieldCallback({
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
        claimYieldCompletion: () => {
          throw new Error("runtime claim failed");
        },
      }),
      onYield,
    });
    await expect(tool.execute("yield-call", {})).rejects.toThrow("runtime claim failed");
    expect(onYield).not.toHaveBeenCalled();
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });
});
