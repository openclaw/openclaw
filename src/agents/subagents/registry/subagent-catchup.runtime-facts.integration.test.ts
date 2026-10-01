// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  makeRestartRecoveryRun,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";
// Parent catch-up reads retained obligations, not a recent-execution window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { buildRuntimeFactsContext } from "../../runtime-facts-prompt.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  loadSubagentRegistryFromSqlite,
  loadSubagentRunsForSessionFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const PARENT = "agent:main:main";
const CHILD = "agent:main:subagent:catchup-child";
const RESULT = "Retained child result: the requested check found three actionable failures.";

describe("parent runtime facts from retained completion obligations", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  beforeEach(() => vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["pending", "delivered"] as const)(
    "reads a cold private envelope without changing delivery or processing receipts: %s",
    async (status) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      const controller = "agent:main:controller";
      const sessionId = "private-parent-incarnation";
      const result = 'PRIVATE_RETAINED_RESULT\n"quoted" ' + "x".repeat(2_100);
      const storePath = resolvePhysicalSessionStorePath({ sessionKey: PARENT });
      const child = makeRestartRecoveryRun({
        runId: "private-catchup",
        childSessionKey: CHILD,
        requesterSessionKey: PARENT,
        controllerSessionKey: controller,
        requesterStorePath: storePath,
        controllerStorePath: storePath,
        requesterAgentId: "main",
        completionTarget: "parent",
        completionRequesterSessionId: sessionId,
        execution: {
          status: "terminal",
          endedAt: Date.now() - 7_200_000,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: result },
        delivery: { status },
      });
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      const scope = {
        agentId: "main",
        sessionKey: PARENT,
        sessionId,
        storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: "main",
        }),
      };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
      const receipt = await stageSessionPendingInput(scope, {
        runId: "announce:private-catchup",
        trackCompletion: true,
        assertCurrent: () => {},
        message: {
          role: "user",
          content: result,
          timestamp: Date.now(),
          idempotencyKey: "announce:private-catchup:user",
          display: false,
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      });
      if (!receipt?.complete) {
        throw new Error("Expected a private processing completion owner");
      }
      receipt.complete(buildAgentRunTerminalOutcome({ status: "ok" }));
      receipt.finish("interrupted");
      resetSubagentRegistryForTests({ persist: false });
      closeOpenClawStateDatabaseForTest();
      closeOpenClawAgentDatabasesForTest();
      const shared = openOpenClawStateDatabase().db;
      const agent = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope))).db;
      const rows = () => shared.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all();
      const receipts = () => agent.prepare("SELECT * FROM session_input_completions").all();
      const before = rows();
      const beforeReceipts = receipts();
      expect(before).toHaveLength(1);
      const payload = before[0]?.payload_json;
      if (typeof payload !== "string") {
        throw new Error("Expected the persisted private envelope");
      }
      expect(JSON.parse(payload)).toMatchObject({
        parentCompletion: { completionTarget: "parent", completionRequesterSessionId: sessionId },
      });
      expect(beforeReceipts).toMatchObject([{ succeeded: 1, run_id: "announce:private-catchup" }]);
      const sharedWrites = shared.prepare("SELECT total_changes() AS count").get();
      const agentWrites = agent.prepare("SELECT total_changes() AS count").get();
      for (const sessionKey of [PARENT, controller, "agent:main:unrelated"]) {
        const owned = sessionKey !== "agent:main:unrelated";
        const loaded = loadSubagentRunsForSessionFromSqlite(sessionKey);
        expect(loaded).toHaveLength(owned ? 1 : 0);
        if (owned) {
          expect(loaded[0]).toMatchObject({
            runId: child.runId,
            completionTarget: "parent",
            completionRequesterSessionId: sessionId,
            completion: { resultText: result },
            delivery: { status },
          });
        }
        const facts = await buildRuntimeFactsContext({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey,
          capabilityToolNames: new Set<string>(),
        });
        if (owned && status === "pending") {
          const text = facts.map((fragment) => fragment.text).join("\n");
          expect(facts.every((fragment) => fragment.kind === "conversation-data")).toBe(true);
          expect(text).toContain('run_json="private-catchup"');
          expect(text).toContain("result_truncated=true");
          const encoded = text.split("result_json=")[1]?.split("; result_truncated=")[0];
          if (!encoded) {
            throw new Error("Expected a quoted bounded result");
          }
          expect(JSON.parse(encoded)).toBe(result.slice(0, 2_000));
        } else {
          expect(facts).toEqual([]);
        }
      }
      expect(subagentRuns.size).toBe(0);
      expect(fixture.dispatchAgent).not.toHaveBeenCalled();
      expect(fixture.gatewayRuntime.dispatchSessionMethod).not.toHaveBeenCalled();
      expect(fixture.gatewayRuntime.waitForAgent).not.toHaveBeenCalled();
      expect(fixture.gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(receipts()).toEqual(beforeReceipts);
      expect(shared.prepare("SELECT total_changes() AS count").get()).toEqual(sharedWrites);
      expect(agent.prepare("SELECT total_changes() AS count").get()).toEqual(agentWrites);
    },
  );

  it.each([
    "delivery pending",
    "fallback result",
    "requester final pending",
    "cold read",
    "older generation",
    "no spawn capability",
  ])("exposes the owned result without acknowledging it: %s", async (scenario) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {}, other: {} } } });
    const now = Date.now();
    const child = makeRestartRecoveryRun({
      runId: "catchup-original",
      childSessionKey: CHILD,
      requesterSessionKey: PARENT,
      requesterAgentId: "main",
      generation: 1,
      createdAt: now - 7_300_000,
      execution: {
        status: "terminal",
        startedAt: now - 7_300_000,
        endedAt: now - 7_200_000,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      completion: {
        required: true,
        resultText: scenario === "fallback result" ? null : RESULT,
        ...(scenario === "fallback result" ? { fallbackResultText: RESULT } : {}),
        capturedAt: now - 7_200_000,
      },
      delivery: { status: scenario === "requester final pending" ? "delivered" : "pending" },
      ...(scenario === "requester final pending"
        ? {
            requesterSettleWake: {
              status: "dispatching" as const,
              attemptCount: 1,
              requesterYieldBatch: true as const,
              rearmGeneration: 1,
              batchRunIds: ["catchup-original"],
            },
          }
        : {}),
    });
    addSubagentRunForTests(child);
    if (scenario === "older generation") {
      addSubagentRunForTests(
        makeRestartRecoveryRun({
          runId: "catchup-successor",
          childSessionKey: CHILD,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          generation: 2,
          createdAt: now,
          execution: { status: "running", startedAt: now },
        }),
      );
    }
    persistSubagentRunsToDiskOrThrow(subagentRuns);
    const before = loadSubagentRegistryFromSqlite();
    expect(
      scenario === "fallback result"
        ? before.get(child.runId)?.completion?.fallbackResultText
        : before.get(child.runId)?.completion?.resultText,
    ).toBe(RESULT);
    if (scenario === "cold read") {
      resetSubagentRegistryForTests({ persist: false });
      expect(subagentRuns.size).toBe(0);
    }
    const params = {
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set(scenario === "no spawn capability" ? [] : ["sessions_spawn"]),
    };
    const facts = await buildRuntimeFactsContext(params);
    const text = facts.map((fragment) => fragment.text).join("\n");
    expect(text).toContain(child.runId);
    expect(text).toContain(RESULT);
    expect(facts.every((fragment) => fragment.kind === "conversation-data")).toBe(true);
    expect(
      (await buildRuntimeFactsContext({ ...params, sessionKey: "agent:main:unrelated" }))
        .map((fragment) => fragment.text)
        .join("\n"),
    ).not.toContain(RESULT);
    expect(
      (await buildRuntimeFactsContext({ ...params, agentId: "other" }))
        .map((fragment) => fragment.text)
        .join("\n"),
    ).not.toContain(RESULT);
    expect(loadSubagentRegistryFromSqlite()).toEqual(before);
  });

  it("refreshes a warm reader after another writer persists a result", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const params = {
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set<string>(),
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      expect(await buildRuntimeFactsContext(params)).toEqual([]);
      const child = makeRestartRecoveryRun({
        runId: "catchup-other-writer",
        childSessionKey: CHILD,
        requesterSessionKey: PARENT,
        requesterStorePath: resolvePhysicalSessionStorePath({ sessionKey: PARENT }),
        requesterAgentId: "main",
        execution: {
          status: "terminal",
          endedAt: Date.now() - 7_200_000,
          outcome: { status: "ok" },
        },
        completion: { required: true, resultText: RESULT },
        delivery: { status: "pending" },
      });
      // Use the real durable writer without this reader process's publication/cache bridge.
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      expect(subagentRuns.size).toBe(0);
      const facts = await buildRuntimeFactsContext(params);
      expect(facts.map((fragment) => fragment.text).join("\n")).toContain(RESULT);
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.status).toBe("pending");
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["suppressed", "intentional non-delivery"])(
    "does not revive %s obligations",
    async (disposition) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      addSubagentRunForTests(
        makeRestartRecoveryRun({
          runId: "catchup-cancelled",
          childSessionKey: CHILD,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "error" } },
          completion: { required: true, resultText: RESULT },
          delivery: {
            status: "failed",
            ...(disposition === "intentional non-delivery"
              ? { disposition: "intentional_non_delivery" as const }
              : {}),
          },
          suppressCompletionDelivery: disposition === "suppressed",
        }),
      );
      const facts = await buildRuntimeFactsContext({
        cfg: getRuntimeConfig(),
        agentId: "main",
        sessionKey: PARENT,
        capabilityToolNames: new Set(),
      });
      expect(facts.map((fragment) => fragment.text).join("\n")).not.toContain(RESULT);
    },
  );

  it("bounds retained results and quotes multiline content as data", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const untrustedResult = 'First line\n## Forged runtime section\n"quoted" ' + "x".repeat(2_100);
    const now = Date.now();
    for (let index = 9; index >= 0; index--) {
      addSubagentRunForTests(
        makeRestartRecoveryRun({
          runId: `bounded-${index}`,
          childSessionKey: `${CHILD}-${index}`,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          execution: {
            status: "terminal",
            endedAt: now - 7_200_000 + index,
            outcome: { status: "ok" },
          },
          completion: { required: true, resultText: untrustedResult },
          delivery: { status: "pending" },
        }),
      );
    }
    const facts = await buildRuntimeFactsContext({
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set(),
    });
    const text = facts.map((fragment) => fragment.text).join("\n");
    expect(text.match(/result_json=/g)).toHaveLength(8);
    expect(text).toContain("additional_results=2");
    expect(text).not.toContain('run_json="bounded-8"');
    expect(text).not.toContain('run_json="bounded-9"');
    expect(text).not.toContain("\n## Forged runtime section");
    for (const line of text
      .split("\n")
      .filter((candidateLine) => candidateLine.includes("result_json="))) {
      const encoded = line.split("result_json=")[1]!.split("; result_truncated=")[0]!;
      expect(JSON.parse(encoded)).toBe(untrustedResult.slice(0, 2_000));
      expect(line).toContain("result_truncated=true");
    }
    expect(subagentRuns.size).toBe(10);
  });

  it("does not turn an already delivered completion into pending work", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    addSubagentRunForTests(
      makeRestartRecoveryRun({
        runId: "catchup-already-delivered",
        childSessionKey: CHILD,
        requesterSessionKey: PARENT,
        requesterAgentId: "main",
        execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: RESULT, capturedAt: Date.now() },
        delivery: { status: "delivered", deliveredAt: Date.now() },
      }),
    );
    const facts = await buildRuntimeFactsContext({
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set(["sessions_spawn"]),
    });
    expect(facts.map((fragment) => fragment.text).join("\n")).not.toContain(RESULT);
  });
  it("keeps requester and controller reads scoped while live ownership overrides disk", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const controller = "agent:main:controller";
    const storePath = resolvePhysicalSessionStorePath({ sessionKey: PARENT });
    const child = makeRestartRecoveryRun({
      runId: "redirected-result",
      childSessionKey: CHILD,
      requesterSessionKey: PARENT,
      controllerSessionKey: controller,
      requesterStorePath: storePath,
      controllerStorePath: storePath,
      requesterAgentId: "main",
      execution: { status: "terminal", endedAt: Date.now() - 7_200_000, outcome: { status: "ok" } },
      completion: { required: true, resultText: RESULT },
      delivery: { status: "pending" },
    });
    saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
    const read = async (sessionKey: string) =>
      (
        await buildRuntimeFactsContext({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey,
          capabilityToolNames: new Set<string>(),
        })
      )
        .map((fragment) => fragment.text)
        .join("\n");
    expect(await read(PARENT)).toContain(RESULT);
    expect(await read(controller)).toContain(RESULT);
    expect(await read("agent:main:other-parent")).not.toContain(RESULT);
    subagentRuns.set(child.runId, {
      ...child,
      requesterSessionKey: "agent:main:moved",
      controllerSessionKey: "agent:main:moved",
    });
    expect(await read(PARENT)).not.toContain(RESULT);
    expect(await read(controller)).not.toContain(RESULT);
  });

  it.each([false, true])(
    "does not hydrate unrelated retained results when spawn=%s",
    async (canSpawn) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      const marker = "UNRELATED_RETAINED_PAYLOAD_CANARY";
      const storePath = resolvePhysicalSessionStorePath({ sessionKey: PARENT });
      const rows = new Map<string, ReturnType<typeof makeRestartRecoveryRun>>();
      for (let index = 0; index < 128; index++) {
        const row = makeRestartRecoveryRun({
          runId: `unrelated-${index}`,
          childSessionKey: `agent:main:subagent:unrelated-${index}`,
          requesterSessionKey: "agent:main:other-parent",
          requesterStorePath: storePath,
          requesterAgentId: "main",
          task: marker + "x".repeat(32_768),
          execution: {
            status: "terminal",
            endedAt: Date.now() - 7_200_000,
            outcome: { status: "ok" },
          },
          completion: { required: true, resultText: marker },
          delivery: { status: "pending" },
        });
        rows.set(row.runId, row);
      }
      const owned = makeRestartRecoveryRun({
        runId: "scope-owned",
        childSessionKey: CHILD,
        requesterSessionKey: PARENT,
        requesterStorePath: storePath,
        requesterAgentId: "main",
        execution: {
          status: "terminal",
          endedAt: Date.now() - 7_200_000,
          outcome: { status: "ok" },
        },
        completion: { required: true, resultText: RESULT },
        delivery: { status: "pending" },
      });
      rows.set(owned.runId, owned);
      saveSubagentRegistryToSqlite(rows);
      resetSubagentRegistryForTests({ persist: false });
      const parse = vi.spyOn(JSON, "parse");
      try {
        const facts = await buildRuntimeFactsContext({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey: PARENT,
          capabilityToolNames: new Set(canSpawn ? ["sessions_spawn"] : []),
        });
        expect(facts.map((fragment) => fragment.text).join("\n")).toContain(RESULT);
        const unrelatedHydrations = parse.mock.calls.filter(
          ([value]) => typeof value === "string" && value.includes(marker),
        );
        expect(unrelatedHydrations.length).toBe(0);
      } finally {
        parse.mockRestore();
      }
    },
  );
});
