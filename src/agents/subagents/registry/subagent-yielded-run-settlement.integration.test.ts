// Real registry, SQLite and sweeper proof that a yielded run no continuation can reach settles.
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentRegistryFixture } from "./subagent-registry-live.test-support.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { appendTranscriptMessage } from "../../../config/sessions/session-accessor.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { captureSubagentCompletionReply as readCompletionReply } from "../announce/subagent-announce-output.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../announce/subagent-announce.js";
import { observeSubagentExecution } from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import {
  registerSubagentRun,
  startQueuedSubagentRun,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

type RunView = { runId: string; status: string };

const T0 = Date.parse("2026-10-03T08:00:00Z");
const MINUTE_MS = 60_000;
const COLLECTOR_KEY = "agent:main:subagent:legacy-collector";
const YIELDED_REPLY = "Collector reply written before the yield";

describe("yielded run settlement", () => {
  const fixture = useSubagentRegistryFixture();

  beforeEach(() => {
    vi.mocked(captureSubagentCompletionReply).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  const useRealCapture = () =>
    vi.mocked(captureSubagentCompletionReply).mockImplementation(readCompletionReply);
  const freezeTime = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  };
  const writeYieldedTranscript = async (
    text = YIELDED_REPLY,
    laterReplies = 0,
    visibility?: { display?: false; earlierReply: string },
  ) => {
    const sessionId = "sess-legacy-collector";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: COLLECTOR_KEY,
      sessionId,
      lifecycleRevision: "collector-incarnation",
      defaultSessionId: sessionId,
    });
    const target = { agentId: "main", sessionKey: COLLECTOR_KEY, sessionId, storePath };
    const append = (
      minutes: number,
      message: Parameters<typeof appendTranscriptMessage>[1]["message"],
      offset = 0,
    ) => appendTranscriptMessage(target, { now: T0 - minutes * MINUTE_MS + offset, message });
    await append(7, { role: "user", content: "Previous task" });
    await append(6, { role: "assistant", content: "Not the collector result either" });
    await append(5, { role: "user", content: "Collect the findings" });
    if (visibility) {
      await append(
        5,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "progress-1", name: "read", arguments: {} }],
        },
        1,
      );
      await append(
        5,
        { role: "toolResult", toolCallId: "progress-1", content: "intermediate data" },
        2,
      );
      await append(5, { role: "assistant", content: visibility.earlierReply }, 3);
    }
    await append(
      4,
      {
        role: "assistant",
        ...(visibility ? { display: visibility.display } : {}),
        content: [
          { type: "text", text },
          { type: "toolCall", id: "yield-1", name: "sessions_yield", arguments: {} },
        ],
      },
      -1,
    );
    await append(4, {
      role: "toolResult",
      toolCallId: "yield-1",
      toolName: "sessions_yield",
      content: [{ type: "text", text: JSON.stringify({ status: "yielded" }) }],
    });
    for (let i = 0; i < laterReplies; i++) {
      await append(1, { role: "user", content: "Unrelated later turn" }, i * 2);
      await append(1, { role: "assistant", content: "Not the collector result" }, i * 2 + 1);
    }
    useRealCapture();
  };
  const persisted = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);
  const waitSurface = async (runId: string) => {
    const tool = createAgentsWaitTool({ agentSessionKey: "agent:main:main", agentId: "main" });
    const result = await tool.execute("wait", { ids: [runId], timeoutSeconds: 0 });
    // The published output schema is the guest-facing contract for every projected field.
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    return result.details as {
      completed: Array<{ status: string; error?: string; result?: string; reason?: string }>;
      pending: string[];
    };
  };
  const collectorId = "live-yielded-collector";
  const registerYieldedCollector = async (
    outcome?: SubagentRunRecord["execution"]["outcome"],
    completion?: SubagentRunRecord["completion"],
  ) => {
    const gatewayContextResolver = getGatewayContextResolver(fixture.gatewayRuntime);
    await registerSubagentRun({
      runId: collectorId,
      childSessionKey: COLLECTOR_KEY,
      childAgentId: "main",
      sessionEntry: {
        sessionId: "sess-legacy-collector",
        lifecycleRevision: "collector-incarnation",
      },
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "Collect the findings",
      cleanup: "keep",
      collect: true,
      groupId: "group-live",
      swarmRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: false,
      gatewayContextResolver,
    });
    expect(
      await startQueuedSubagentRun(collectorId, undefined, undefined, gatewayContextResolver),
    ).toBe(true);
    await fixture.settle();
    // Keep the accepted run's current Gateway and generation while setting its yielded state.
    await mutateSubagentRuns([collectorId], (rows) => {
      const current = rows.get(collectorId);
      if (!current) {
        throw new Error("Live collector registration was not published");
      }
      const yielded: SubagentRunRecord = {
        ...current,
        pauseReason: "sessions_yield",
        execution: {
          ...current.execution,
          status: "terminal",
          startedAt: T0 - 5 * MINUTE_MS,
          endedAt: T0 - 4 * MINUTE_MS,
          outcome,
        },
        ...(completion ? { completion } : {}),
      };
      return { value: undefined, postimages: new Map([[collectorId, yielded]]) };
    });
  };
  const sweep = async () => {
    await testing.sweepOnceForTests();
    await fixture.settle();
  };
  const settleCollector = async (
    outcome: SubagentRunRecord["execution"]["outcome"],
    transcript: Parameters<typeof writeYieldedTranscript> = [],
  ) => {
    freezeTime();
    await writeYieldedTranscript(...transcript);
    await registerYieldedCollector(outcome);
    await sweep();
  };
  const expectSilentResult = async (runId: string, expected: Record<string, unknown>) => {
    expect((await waitSurface(runId)).completed).toMatchObject([expected]);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  };

  it("reads the yielded turn rather than unrelated later turns beyond the recent-message window", async () => {
    await settleCollector({ status: "ok" }, [YIELDED_REPLY, 65]);
    await expectSilentResult(collectorId, { status: "done", result: YIELDED_REPLY });
  });

  it.each([
    { name: "explicitly hidden", text: "Hidden collector text", display: false, status: "ok" },
    { name: "empty", text: "", display: undefined, status: "timeout" },
    { name: "whitespace-only", text: "  \n  ", display: undefined, status: "ok" },
  ] as const)(
    "does not resurrect earlier output when the $status collector yield is $name",
    async ({ text, display, status }) => {
      await settleCollector({ status }, [
        text,
        1,
        {
          display,
          earlierReply: "Earlier progress is not the final result",
        },
      ]);
      expect(persisted(collectorId)?.execution.outcome?.status).toBe(status);
      expect(persisted(collectorId)?.completion?.resultText).toBeNull();
      await expectSilentResult(collectorId, {
        status: status === "ok" ? "done" : "timeout",
        result: "",
      });
    },
  );

  it.each(["NO_REPLY", "HEARTBEAT_OK"])(
    "preserves intentional silent collector output (%j)",
    async (reply) => {
      await settleCollector({ status: "ok" }, [reply, 1]);
      expect(persisted(collectorId)?.completion?.resultText).toBe(reply);
      // The existing delivery policy consumes silent tokens rather than exposing them.
      await expectSilentResult(collectorId, { status: "done", result: "" });
    },
  );

  it.each(["immediate", "drain"] as const)(
    "retries a failed postcommit cleanup claim without losing or announcing the collected result (%s)",
    async (retry) => {
      vi.useFakeTimers({
        toFake: retry === "drain" ? ["Date", "setTimeout", "clearTimeout"] : ["Date"],
      });
      vi.setSystemTime(T0);
      await writeYieldedTranscript();
      // Isolate postcommit retry from transcript capture: this reply is already frozen.
      await registerYieldedCollector(
        { status: "ok" },
        { required: false, resultText: YIELDED_REPLY, capturedAt: T0 - 4 * MINUTE_MS },
      );
      let injected = 0;
      using _ = probe.command(stateWorker, async (command, executeOptions, scope) => {
        const next = isSubagentRegistryWriteCommand(command)
          ? command.input.values.find((row) => row.run_id === collectorId)
          : undefined;
        const entry = next && rowToSubagentRunRecord(next);
        if (
          injected < (retry === "drain" ? 2 : 1) &&
          entry?.browserCleanupDispatchedAt !== undefined
        ) {
          injected++;
          if (retry === "drain") {
            markGatewayRestartDraining();
          }
          // Refuse only the later cleanup claim, after the durable terminal commit.
          expect(persisted(collectorId)).toMatchObject({
            collectorCompletion: { status: "done" },
            completion: { resultText: YIELDED_REPLY },
          });
          expect(persisted(collectorId)?.browserCleanupDispatchedAt).toBeUndefined();
          throw new Error("injected postcommit browser claim write failure");
        }
        return scope.execute(command, executeOptions);
      });
      await testing.sweepOnceForTests();
      // The observer retains the first failed root even though the completion owner retries it.
      await expect(fixture.settle()).rejects.toThrow("Failed to settle subagent cleanup roots");
      await fixture.settle();
      if (retry === "drain") {
        expect(persisted(collectorId)?.browserCleanupDispatchedAt).toBeUndefined();
        resetGatewayWorkAdmission();
        await vi.advanceTimersByTimeAsync(1_000);
        await fixture.settle();
      }
      expect(injected).toBe(retry === "drain" ? 2 : 1);
      expect(persisted(collectorId)?.browserCleanupDispatchedAt).toBeTypeOf("number");
      expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      await expectSilentResult(collectorId, {
        status: "done",
        result: YIELDED_REPLY,
      });
      await sweep();
      expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    },
  );

  it("never reports a yielded run as done or finished while its waiter pends", async () => {
    freezeTime();
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: COLLECTOR_KEY,
      sessionId: "sess-legacy-collector",
      lifecycleRevision: "collector-incarnation",
      defaultSessionId: "sess-legacy-collector",
    });
    await registerYieldedCollector();
    const surfaces = async () => {
      const entry = subagentRuns.get(collectorId) as SubagentRunRecord;
      const waiter = await waitSurface(collectorId);
      const listed = (
        await createSubagentsTool({ agentSessionKey: "agent:main:main", agentId: "main" }).execute(
          "list",
          { action: "list" },
        )
      ).details as { active: Array<RunView>; recent: Array<RunView> };
      const active = listed.active.find((run) => run.runId === entry.runId);
      const recent = listed.recent.find((run) => run.runId === entry.runId);
      return {
        display: resolveSubagentDisplayStatus(entry),
        observed: observeSubagentExecution(entry, []).state,
        waiter: waiter.completed.length > 0 ? waiter.completed[0]?.status : "pending",
        list: active ? `active: ${active.status}` : recent ? `recent: ${recent.status}` : "absent",
      };
    };
    // Before settlement every surface answers "not finished".
    expect(await surfaces()).toEqual({
      display: "waiting for external continuation",
      observed: "waiting",
      waiter: "pending",
      list: "active: waiting for external continuation",
    });
    await sweep();
    // After settlement every surface answers "failed" and none still answers "waiting".
    expect(await surfaces()).toEqual({
      display: "failed",
      observed: "finished",
      waiter: "failed",
      list: "recent: failed",
    });
  });
});
