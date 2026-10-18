// Subagent list tests cover active/recent formatting, usage summaries, and
// stale-run filtering for the user-visible subagent status command.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { buildSubagentListForTests as buildSubagentList } from "./subagent-list.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = Date.now();
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    cleanup: "keep",
    createdAt: now,
    execution: { status: "running", startedAt: now },
    ...overrides,
  };
}

const listRuns = (runs: SubagentRunRecord[], cfg: OpenClawConfig = {}) =>
  buildSubagentList({ cfg, runs, recentMinutes: 30 });

beforeEach(async () => {
  await resetSubagentRegistryForTests();
  setRuntimeConfigSnapshot({});
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("buildSubagentList", () => {
  it("enriches unbound mixed children from memory and recorded durable owners", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const authority = { assertCurrent() {}, authorize() {} };
      const owners = ["main", "research"].map((agentId) =>
        memorySessionActorOwners.get({
          agentId,
          path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env }),
        }),
      );
      const now = Date.now();
      const runs: SubagentRunRecord[] = [];
      try {
        for (const owner of owners) {
          for (const incognito of [false, true]) {
            const childSessionKey = incognito
              ? `agent:${owner.agentId}:subagent:incognito-list`
              : "global";
            const runId = `${owner.agentId}-${incognito ? "private" : "durable"}`;
            const entry: SessionEntry = {
              sessionId: runId,
              lifecycleRevision: runId,
              updatedAt: now,
              model: `openai/${runId}`,
              ...(incognito ? { incognito: true } : {}),
            };
            if (incognito) {
              const actor = await owner.acquire(
                { database: owner.identity, sessionKey: childSessionKey },
                { assertCurrent() {}, assertReadable() {} },
              );
              try {
                expect(
                  (
                    await actor.storage!.mutate(
                      { type: "session.entry.create", input: { entry } },
                      authority,
                    )
                  ).kind,
                ).toBe("committed");
              } finally {
                await actor.release();
              }
            } else {
              await replaceSessionEntry(
                { agentId: owner.agentId, sessionKey: childSessionKey },
                entry,
              );
            }
            runs.push(
              makeRun(runId, {
                childSessionKey,
                childAgentId: owner.agentId,
                model: "openai/fallback",
                createdAt: now,
                execution: { status: "running", startedAt: now },
              }),
            );
          }
        }
        runs.push({
          ...runs[0]!,
          runId: "missing-private",
          childAgentId: "missing",
          childSessionKey: "agent:missing:subagent:incognito-list",
          model: "openai/fallback",
        });
        const list = await buildSubagentList({
          cfg: {},
          runs,
          recentMinutes: 30,
          readSnapshot: new Map(),
        });
        expect(new Map(list.active.map((entry) => [entry.runId, entry.model]))).toEqual(
          new Map([
            ["main-durable", "openai/main-durable"],
            ["main-private", "openai/main-private"],
            ["research-durable", "openai/research-durable"],
            ["research-private", "openai/research-private"],
            ["missing-private", "openai/fallback"],
          ]),
        );
        owners[0]!.closeSession("agent:main:subagent:incognito-list");
        const closed = await buildSubagentList({
          cfg: {},
          runs,
          recentMinutes: 30,
          readSnapshot: new Map(),
        });
        expect(closed.active.find((entry) => entry.runId === "main-private")?.model).toBe(
          "openai/fallback",
        );
      } finally {
        for (const owner of owners) {
          memorySessionActorOwners.closeDatabase(owner);
        }
      }
    });
  });

  it("reads fresh active and recent metadata from each visible child's store", async () => {
    await withOpenClawTestState({ label: "subagent-list-selection" }, async (state) => {
      const cfg: OpenClawConfig = {
        session: { store: state.statePath("agents/{agentId}/sessions/sessions.json") },
      };
      setRuntimeConfigSnapshot(cfg);
      const now = Date.now();
      const runs = [
        { agentId: "main", name: "active", ended: false },
        { agentId: "main", name: "recent", ended: true },
        { agentId: "research", name: "other-store", ended: false },
        { agentId: "research", name: "missing", ended: false },
        { agentId: "main", name: "main-global", ended: false, raw: true },
        { agentId: "research", name: "research-global", ended: false, raw: true },
      ].map(({ agentId, name, ended, raw }, index) =>
        makeRun(`run-${name}`, {
          childSessionKey: raw ? "global" : `agent:${agentId}:subagent:${name}`,
          childAgentId: raw ? agentId : undefined,
          task: name,
          model: "openai/run-fallback",
          createdAt: now - 1000 - index,
          execution: ended
            ? { status: "terminal", endedAt: now - 100, outcome: { status: "ok" } }
            : { status: "running", startedAt: now - 1000 - index },
        }),
      );
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

  it("keeps a yielded child visible with its real wait and independent delivery state", async () => {
    const now = Date.now();
    const parent = makeRun("yielded-parent", {
      task: "Wait for remote evidence",
      createdAt: now - 3_600_000,
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: now - 3_500_000, outcome: { status: "ok" } },
      delivery: { status: "pending" },
    });
    await addSubagentRunForTests(parent);
    const list = () => listRuns([parent]);
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
    expect((await listRuns([killed])).active).toEqual([]);
  });

  it("builds the subagent list without decoding unrelated session metadata or saved prompts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      try {
        const storePath = state.statePath("agents/main/sessions/sessions.json");
        const cfg: OpenClawConfig = { session: { store: storePath } };
        setRuntimeConfigSnapshot(cfg);
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
        const run = makeRun("run-metadata-target", {
          childSessionKey,
          task: "inspect metadata reads",
          taskName: "review_subagents",
          label: "Review worker",
          execution: { status: "queued" },
        });
        await addSubagentRunForTests(run);

        const parse = vi.spyOn(JSON, "parse");
        try {
          const list = await buildSubagentList({
            cfg,
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
            taskName: "review_subagents",
          });
          expect(list.active[0]?.line).toContain("review_subagents: Review worker");
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
      }
    });
  });

  it("shows finished ancestors as done while suspended child results remain available", async () => {
    const now = Date.now();
    const parent = makeRun("finished-parent", {
      task: "orchestrate child workers",
      createdAt: now - 120_000,
      execution: { status: "terminal", endedAt: now - 60_000, outcome: { status: "ok" } },
    });
    const child = {
      ...parent,
      runId: "suspended-child",
      childSessionKey: "agent:main:subagent:suspended-child",
      requesterSessionKey: parent.childSessionKey,
      delivery: { status: "suspended", suspendedAt: now, suspendedReason: "expiry" },
    } satisfies SubagentRunRecord;
    await addSubagentRunForTests(parent);
    await addSubagentRunForTests(child);
    const list = () => listRuns([parent, child]);

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

  it("preserves timeout status while descendants remain pending", async () => {
    const now = Date.now();
    const expectedStatus = "timeout (waiting on 2 children)";
    const parentRun = makeRun("timed-out-parent", {
      task: "orchestrate child workers",
      createdAt: now - 120_000,
      execution: {
        status: "terminal",
        startedAt: now - 120_000,
        endedAt: now - 60_000,
        outcome: { status: "timeout" },
      },
    });
    await addSubagentRunForTests(parentRun);
    const childSessions = [0, 1].map(
      (index) => `${parentRun.childSessionKey}:subagent:child-${index}`,
    );
    for (const [childIndex, childSessionKey] of childSessions.entries()) {
      await addSubagentRunForTests(
        makeRun(`${parentRun.runId}-child-${childIndex}`, {
          childSessionKey,
          requesterSessionKey: parentRun.childSessionKey,
          requesterDisplayKey: "subagent:parent",
          task: "child worker still running",
          createdAt: now - 30_000,
          execution: { status: "running", startedAt: now - 30_000 },
        }),
      );
    }

    const list = await listRuns([parentRun]);

    expect(list.active).toHaveLength(1);
    expect(list.active[0]).toMatchObject({
      runId: parentRun.runId,
      status: expectedStatus,
      pendingDescendants: 2,
    });
    expect(list.active[0]?.line).toContain(` ${expectedStatus}`);
    expect(list.active[0]?.childSessions).toEqual(childSessions);
    expect(list.recent).toStrictEqual([]);
  });
});
