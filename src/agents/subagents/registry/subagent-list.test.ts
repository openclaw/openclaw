// Subagent list tests cover active/recent formatting, usage summaries, and
// stale-run filtering for the user-visible subagent status command.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { withIncognitoSessionBinding } from "../../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { captureOpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { buildSubagentListForTests as buildSubagentList } from "./subagent-list.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Capacity under incognito is a P12 prerequisite; this contract needs two actors and durable storage.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-list-"));
});

afterAll(async () => {
  await cleanupSessionStateForTest({ stateDir: testWorkspaceDir });
  await fs.rm(testWorkspaceDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

beforeEach(async () => {
  await resetSubagentRegistryForTests();
});

describe("buildSubagentList", () => {
  it("enriches mixed children from their captured actors and recorded durable owners", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const authority = { assertCurrent() {} };
      const actors = await Promise.all(
        ["main", "research"].map((agentId) =>
          captureOpenClawAgentDatabaseExecution({
            kind: "ephemeral",
            agentId,
            env: state.env,
            authority,
          }),
        ),
      );
      const now = Date.now();
      const runs: SubagentRunRecord[] = [];
      try {
        for (const actor of actors) {
          if (!actor) {
            throw new Error("Expected test-owned incognito actor");
          }
          for (const incognito of [false, true]) {
            const childSessionKey = incognito
              ? `agent:${actor.agentId}:subagent:incognito-list`
              : "global";
            const runId = `${actor.agentId}-${incognito ? "private" : "durable"}`;
            const entry: SessionEntry = {
              sessionId: runId,
              lifecycleRevision: runId,
              updatedAt: now,
              model: `openai/${runId}`,
              ...(incognito ? { incognito: true } : {}),
            };
            if (incognito) {
              await actor.sessions.create(authority, { sessionKey: childSessionKey, entry });
            } else {
              await replaceSessionEntry(
                { agentId: actor.agentId, sessionKey: childSessionKey },
                entry,
              );
            }
            runs.push({
              runId,
              childSessionKey,
              childAgentId: actor.agentId,
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: runId,
              cleanup: "keep",
              createdAt: now,
              execution: { status: "running", startedAt: now },
            });
          }
        }
        runs.push({
          ...runs[0]!,
          runId: "missing-private",
          childAgentId: "missing",
          childSessionKey: "agent:missing:subagent:incognito-list",
          model: "openai/fallback",
        });
        const actor = actors[0]!;
        if (!actor) {
          throw new Error("Expected the main actor");
        }
        const list = await withIncognitoSessionBinding({ actor }, () =>
          buildSubagentList({ cfg: {}, runs, recentMinutes: 30, readSnapshot: new Map() }),
        );
        expect(new Map(list.active.map((entry) => [entry.runId, entry.model]))).toEqual(
          new Map([
            ["main-durable", "openai/main-durable"],
            ["main-private", "openai/main-private"],
            ["research-durable", "openai/research-durable"],
            ["research-private", "openai/research-private"],
            ["missing-private", "openai/fallback"],
          ]),
        );
        expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toHaveLength(2);
        await actor.close();
        await expect(
          withIncognitoSessionBinding({ actor }, () =>
            buildSubagentList({ cfg: {}, runs, recentMinutes: 30, readSnapshot: new Map() }),
          ),
        ).rejects.toThrow();
      } finally {
        await Promise.all(
          actors.map(async (actor) => {
            await actor?.close();
          }),
        );
      }
    });
  });

  it("reads fresh active and recent metadata from each visible child's store", async () => {
    await withOpenClawTestState({ label: "subagent-list-selection" }, async (state) => {
      const cfg: OpenClawConfig = {
        session: { store: state.statePath("agents/{agentId}/sessions/sessions.json") },
      };
      const now = Date.now();
      const runs = [
        { agentId: "main", name: "active", ended: false },
        { agentId: "main", name: "recent", ended: true },
        { agentId: "research", name: "other-store", ended: false },
        { agentId: "research", name: "missing", ended: false },
        { agentId: "main", name: "main-global", ended: false, raw: true },
        { agentId: "research", name: "research-global", ended: false, raw: true },
      ].map(({ agentId, name, ended, raw }, index): SubagentRunRecord => ({
        runId: `run-${name}`,
        childSessionKey: raw ? "global" : `agent:${agentId}:subagent:${name}`,
        childAgentId: raw ? agentId : undefined,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: name,
        model: "openai/run-fallback",
        cleanup: "keep",
        createdAt: now - 1000 - index,
        execution: ended
          ? { status: "terminal", endedAt: now - 100, outcome: { status: "ok" } }
          : { status: "running", startedAt: now - 1000 - index },
      }));
      for (const run of runs.filter((entry) => entry.task !== "missing")) {
        await replaceSessionEntry(
          { sessionKey: run.childSessionKey, agentId: run.childAgentId },
          {
            sessionId: run.runId,
            updatedAt: now,
            modelProvider: "openai",
            model: `saved-${run.task}`,
          },
        );
      }
      const list = () =>
        buildSubagentList({ cfg, runs, recentMinutes: 30, readSnapshot: new Map() });
      expect((await list()).active.map(({ sessionKey, model }) => ({ sessionKey, model }))).toEqual(
        [
          { sessionKey: runs[0]!.childSessionKey, model: "openai/saved-active" },
          { sessionKey: runs[2]!.childSessionKey, model: "openai/saved-other-store" },
          { sessionKey: runs[3]!.childSessionKey, model: "openai/run-fallback" },
          { sessionKey: "global", model: "openai/saved-main-global" },
          { sessionKey: "global", model: "openai/saved-research-global" },
        ],
      );
      expect((await list()).recent).toMatchObject([{ model: "openai/saved-recent" }]);
      await replaceSessionEntry(
        { sessionKey: runs[0]!.childSessionKey },
        { sessionId: runs[0]!.runId, updatedAt: now + 1, model: "openai/replaced" },
      );
      expect((await list()).active[0]?.model).toBe("openai/replaced");
    });
  });

  it("reads a raw child's metadata from its recorded owner in a custom store", async () => {
    await withOpenClawTestState({ label: "subagent-list-custom-store" }, async (state) => {
      const storePath = state.statePath("custom/sessions.sqlite");
      const now = Date.now();
      const run: SubagentRunRecord = {
        runId: "research-global",
        childSessionKey: "global",
        childAgentId: "research",
        requesterSessionKey: "agent:research:main",
        requesterDisplayKey: "research",
        task: "Read the custom store",
        cleanup: "keep",
        createdAt: now,
        execution: { status: "running", startedAt: now },
      };
      await replaceSessionEntry(
        { agentId: "research", storePath, sessionKey: "global" },
        { sessionId: "research-global", updatedAt: now, model: "openai/research-model" },
      );
      const list = await buildSubagentList({
        cfg: { session: { store: storePath } },
        runs: [run],
        recentMinutes: 30,
        readSnapshot: new Map(),
      });
      expect(list.active).toMatchObject([
        { runId: "research-global", sessionKey: "global", model: "openai/research-model" },
      ]);
    });
  });

  it("keeps a yielded child visible with its real wait and independent delivery state", async () => {
    const now = Date.now();
    const parent: SubagentRunRecord = {
      runId: "yielded-parent",
      childSessionKey: "agent:main:subagent:yielded-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Wait for remote evidence",
      cleanup: "keep",
      createdAt: now - 3_600_000,
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: now - 3_500_000, outcome: { status: "ok" } },
      delivery: { status: "pending" },
    };
    await addSubagentRunForTests(parent);
    const list = () => buildSubagentList({ cfg: {}, runs: [parent], recentMinutes: 30 });
    expect((await list()).active[0]).toMatchObject({
      status: "waiting for external continuation",
      execution: { state: "waiting", wait: { kind: "external" } },
      deliveryStatus: "pending",
    });

    const child: SubagentRunRecord = {
      ...parent,
      runId: "evidence-child",
      childSessionKey: "agent:main:subagent:evidence-child",
      requesterSessionKey: parent.childSessionKey,
      createdAt: now,
      pauseReason: undefined,
      execution: { status: "running", startedAt: now },
      expectsCompletionMessage: true,
    };
    await addSubagentRunForTests(child);
    expect((await list()).active[0]?.execution).toEqual({
      state: "waiting",
      wait: {
        kind: "children",
        pendingCount: 1,
        dependencies: [{ runId: child.runId, sessionKey: child.childSessionKey }],
      },
    });
    await addSubagentRunForTests({ ...child, expectsCompletionMessage: false });
    expect((await list()).active[0]).toMatchObject({
      status: "waiting for external continuation",
      execution: { state: "waiting", wait: { kind: "external" } },
    });
    await resetSubagentRegistryForTests();
    const killed = { ...parent, endedReason: SUBAGENT_ENDED_REASON_KILLED };
    await addSubagentRunForTests(killed);
    expect(
      (await buildSubagentList({ cfg: {}, runs: [killed], recentMinutes: 30 })).active,
    ).toEqual([]);
  });

  it("builds the subagent list without decoding unrelated session metadata or saved prompts", async () => {
    const stateDir = await fs.mkdtemp(path.join(testWorkspaceDir, "metadata-"));
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      try {
        const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
        const childSessionKey = "agent:main:subagent:target";
        for (let i = 0; i < 20; i++) {
          await replaceSessionEntry(
            { storePath, sessionKey: `agent:main:subagent:other-${i}` },
            {
              sessionId: `other-${i}`,
              updatedAt: 1,
              label: `UNRELATED_PAYLOAD_${i}`,
              skillsSnapshot: { prompt: `UNRELATED_PAYLOAD_${"x".repeat(4096)}`, skills: [] },
            },
          );
        }
        await replaceSessionEntry(
          { storePath, sessionKey: childSessionKey },
          {
            sessionId: "target",
            updatedAt: Date.now(),
            inputTokens: 12,
            outputTokens: 1000,
            totalTokens: 197000,
            totalTokensFresh: true,
            totalTokensVersion: 1,
            model: "demo/runtime-model",
          },
        );
        const run = {
          runId: "run-metadata-target",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "inspect metadata reads",
          cleanup: "keep",
          createdAt: Date.now(),
          execution: { status: "queued" },
        } satisfies SubagentRunRecord;
        await addSubagentRunForTests(run);

        const parse = vi.spyOn(JSON, "parse");
        try {
          const list = await buildSubagentList({
            cfg: { session: { store: storePath } },
            runs: [run],
            recentMinutes: 30,
            taskMaxChars: 110,
          });
          expect(list.active).toHaveLength(1);
          expect(list.active[0]).toMatchObject({
            runId: run.runId,
            sessionKey: childSessionKey,
            model: "demo/runtime-model",
            status: "queued",
            totalTokens: 197000,
          });
          expect(list.active[0]?.line).toContain("prompt/cache 197k");
          expect(list.active[0]?.line).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
          expect(list.active[0]?.line).not.toContain("1k io");
          const unrelatedParses = parse.mock.calls.filter(
            ([value]) => typeof value === "string" && value.includes("UNRELATED_PAYLOAD_"),
          ).length;
          expect(unrelatedParses).toBe(0);
        } finally {
          parse.mockRestore();
        }
      } finally {
        await resetSubagentRegistryForTests();
        await cleanupSessionStateForTest({ stateDir });
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  it("truncates long task text in list lines", async () => {
    const run = {
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep",
      createdAt: 1000,
      execution: { status: "running", startedAt: 1000 },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(run);
    const list = await buildSubagentList({
      cfg: {},
      runs: [run],
      recentMinutes: 30,
      taskMaxChars: 110,
    });
    expect(list.active[0]?.task).toHaveLength(110);
    expect(list.active[0]?.task).toMatch(/\.\.\.$/);
    expect(list.active[0]?.line).not.toContain("after a short hard cutoff.");
  });

  it("shows taskName in list lines and structured views", async () => {
    const run = {
      runId: "run-task-name",
      childSessionKey: "agent:main:subagent:task-name",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "review the subagent orchestration code",
      taskName: "review_subagents",
      cleanup: "keep",
      label: "Review worker",
      createdAt: 1000,
      execution: { status: "running", startedAt: 1000 },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(run);

    const list = await buildSubagentList({
      cfg: {},
      runs: [run],
      recentMinutes: 30,
    });

    expect(list.active[0]?.taskName).toBe("review_subagents");
    expect(list.active[0]?.line).toContain("review_subagents: Review worker");
  });

  it("projects failed runs into recent output", async () => {
    const now = Date.now();
    const run = {
      runId: "run-status-failed",
      childSessionKey: "agent:main:subagent:status-failed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "report the actual child outcome",
      cleanup: "keep",
      createdAt: now - 2_000,
      execution: {
        status: "terminal",
        startedAt: now - 2_000,
        endedAt: now - 1_000,
        outcome: { status: "error", error: "provider rejected the request" },
      },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(run);

    const list = await buildSubagentList({ cfg: {}, runs: [run], recentMinutes: 30 });

    expect(list.recent[0]?.status).toBe("failed");
    expect(list.recent[0]?.line).toContain(" failed");
  });

  it("shows finished ancestors as done while suspended child results remain available", async () => {
    const now = Date.now();
    const parent = {
      runId: "finished-parent",
      childSessionKey: "agent:main:subagent:finished-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: { status: "terminal", endedAt: now - 60_000, outcome: { status: "ok" } },
    } satisfies SubagentRunRecord;
    const child = {
      ...parent,
      runId: "suspended-child",
      childSessionKey: "agent:main:subagent:suspended-child",
      requesterSessionKey: parent.childSessionKey,
      delivery: { status: "suspended", suspendedAt: now, suspendedReason: "expiry" },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(parent);
    await addSubagentRunForTests(child);
    const list = () => buildSubagentList({ cfg: {}, runs: [parent, child], recentMinutes: 30 });

    const finished = await list();
    expect(finished.active).toEqual([]);
    expect(finished.recent).toMatchObject([
      { runId: parent.runId, status: "done", pendingDescendants: 0 },
      { runId: child.runId, status: "done", deliveryStatus: "suspended" },
    ]);
    expect(finished.text).not.toContain("waiting on");

    await addSubagentRunForTests({
      ...parent,
      runId: "live-grandchild",
      childSessionKey: "agent:main:subagent:live-grandchild",
      requesterSessionKey: child.childSessionKey,
      createdAt: now,
      execution: { status: "running", startedAt: now },
    });
    const active = await list();
    expect(active.active).toMatchObject([
      { runId: parent.runId, status: "active (waiting on 1 child)", pendingDescendants: 1 },
      { runId: child.runId, status: "active (waiting on 1 child)", pendingDescendants: 1 },
    ]);
    expect(active.recent).toEqual([]);
  });

  it.each([
    {
      name: "a killed parent with an earlier successful provider outcome",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "ok" } as const,
      pendingChildren: 2,
      expectedStatus: "killed (waiting on 2 children)",
    },
    {
      name: "a failed parent",
      outcome: { status: "error", error: "provider rejected the request" } as const,
      pendingChildren: 1,
      expectedStatus: "failed (waiting on 1 child)",
    },
    {
      name: "a timed-out parent",
      outcome: { status: "timeout" } as const,
      pendingChildren: 2,
      expectedStatus: "timeout (waiting on 2 children)",
    },
    {
      name: "a successfully completed parent",
      outcome: { status: "ok" } as const,
      pendingChildren: 2,
      expectedStatus: "active (waiting on 2 children)",
    },
    {
      name: "a still-running parent",
      ended: false,
      pendingChildren: 1,
      expectedStatus: "active (waiting on 1 child)",
    },
  ])(
    "preserves the status of $name while descendants remain pending",
    async ({ endedReason, outcome, ended, pendingChildren, expectedStatus }) => {
      const now = Date.now();
      const parentRun = {
        runId: `run-parent-${expectedStatus.replaceAll(" ", "-")}`,
        childSessionKey: `agent:main:subagent:parent-${expectedStatus.replaceAll(" ", "-")}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "orchestrate child workers",
        cleanup: "keep",
        createdAt: now - 120_000,
        execution:
          ended === false
            ? { status: "running", startedAt: now - 120_000 }
            : {
                status: "terminal",
                startedAt: now - 120_000,
                endedAt: now - 60_000,
                outcome,
              },
        ...(endedReason ? { endedReason } : {}),
      } satisfies SubagentRunRecord;
      await addSubagentRunForTests(parentRun);
      for (let childIndex = 0; childIndex < pendingChildren; childIndex += 1) {
        await addSubagentRunForTests({
          runId: `${parentRun.runId}-child-${childIndex}`,
          childSessionKey: `${parentRun.childSessionKey}:subagent:child-${childIndex}`,
          requesterSessionKey: parentRun.childSessionKey,
          requesterDisplayKey: "subagent:parent",
          task: "child worker still running",
          cleanup: "keep",
          createdAt: now - 30_000,
          startedAt: now - 30_000,
        });
      }

      const list = await buildSubagentList({
        cfg: {},
        runs: [parentRun],
        recentMinutes: 30,
      });

      expect(list.active).toHaveLength(1);
      expect(list.active[0]).toMatchObject({
        runId: parentRun.runId,
        status: expectedStatus,
        pendingDescendants: pendingChildren,
      });
      expect(list.active[0]?.line).toContain(` ${expectedStatus}`);
      expect(list.active[0]?.childSessions).toEqual(
        Array.from(
          { length: pendingChildren },
          (_, childIndex) => `${parentRun.childSessionKey}:subagent:child-${childIndex}`,
        ),
      );
      expect(list.recent).toStrictEqual([]);
    },
  );

  it("omits old ended descendants from child session summaries", async () => {
    const now = Date.now();
    const parentRun = {
      runId: "run-parent-active-old-child",
      childSessionKey: "agent:main:subagent:parent-active-old-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent active",
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: { status: "running", startedAt: now - 120_000 },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(parentRun);
    await addSubagentRunForTests({
      runId: "run-old-ended-child-summary",
      childSessionKey: `${parentRun.childSessionKey}:subagent:old-ended-child`,
      requesterSessionKey: parentRun.childSessionKey,
      requesterDisplayKey: "subagent:parent-active-old-child",
      task: "old ended child",
      cleanup: "keep",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });

    const list = await buildSubagentList({
      cfg: {},
      runs: [parentRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active[0]?.childSessions).toBeUndefined();
  });

  it("keeps stale unended runs out of active and recent list output", async () => {
    const now = Date.now();
    const staleRun = {
      runId: "run-stale-list",
      childSessionKey: "agent:main:subagent:stale-list",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale hidden work",
      cleanup: "keep",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: {
        status: "running",
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(staleRun);

    const list = await buildSubagentList({
      cfg: {},
      runs: [staleRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.total).toBe(1);
    expect(list.active).toStrictEqual([]);
    expect(list.recent).toStrictEqual([]);
    expect(list.text).toContain("active subagents:\n(none)");
    expect(list.text).toContain("recent (last 30m):\n(none)");
  });

  it("does not let a stale unended child keep an ended parent listed active", async () => {
    const now = Date.now();
    const parentRun = {
      runId: "run-parent-ended-stale-child",
      childSessionKey: "agent:main:subagent:parent-ended-stale-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent ended",
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: {
        status: "terminal",
        startedAt: now - 120_000,
        endedAt: now - 60_000,
        outcome: { status: "ok" },
      },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(parentRun);
    await addSubagentRunForTests({
      runId: "run-stale-child",
      childSessionKey: `${parentRun.childSessionKey}:subagent:stale-child`,
      requesterSessionKey: parentRun.childSessionKey,
      requesterDisplayKey: "subagent:parent-ended-stale-child",
      task: "stale child",
      cleanup: "keep",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
    });

    const list = await buildSubagentList({
      cfg: {},
      runs: [parentRun],
      recentMinutes: 30,
      taskMaxChars: 110,
    });

    expect(list.active).toStrictEqual([]);
    expect(list.recent[0]?.status).toBe("done");
  });
});
