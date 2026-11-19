import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  terminateLiveSubagentsForShutdown,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

it.each(["crash", "shutdown"] as const)(
  "collects recorded child outcomes after %s",
  async (restart) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await resetSubagentRegistryForTests({ persist: false });
      await captureRuntimeConfigAsyncReader()();
      const startedAt = Math.floor(performance.timeOrigin) - 1000;
      const entries = ["captured", "interrupted-1", "interrupted-2"].map((runId) =>
        createSubagentRunRecord({
          runId,
          childAgentId: "main",
          childSessionKey: `agent:main:subagent:${runId}`,
          childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          swarmRequesterSessionKey: "agent:main:main",
          collect: true,
          expectsCompletionMessage: false,
          createdAt: startedAt,
          execution:
            runId === "captured"
              ? { status: "terminal", startedAt, endedAt: startedAt + 1, outcome: { status: "ok" } }
              : { status: "running", startedAt },
          ...(runId === "captured"
            ? {
                completion: {
                  required: false,
                  resultText: "saved result",
                  capturedAt: startedAt + 1,
                },
                collectorCompletion: { status: "done" },
              }
            : {}),
        }),
      );
      const restore = () =>
        createSubagentRegistryRestorer({
          runs: subagentRuns,
          ensureListener() {},
          warn() {},
        }).activate();
      const claims: Array<{ runId: string; token: ReturnType<typeof claimAgentRunContext> }> = [];
      try {
        saveSubagentRegistryToSqlite(new Map(entries.map((entry) => [entry.runId, entry])));
        await restore();
        if (restart === "shutdown") {
          const gateway = createContext();
          const resolveGatewayContext = () => gateway;
          for (const entry of subagentRuns.values()) {
            bindGatewayContextResolver(entry, resolveGatewayContext);
            if (entry.execution.status === "running") {
              const token = claimAgentRunContext(
                entry.runId,
                { agentId: "main", sessionKey: entry.childSessionKey },
                { trackOwner: true, ownsContext: true },
              );
              expect(token).toBeDefined();
              claims.push({ runId: entry.runId, token });
            }
          }
          markGatewayRestartDraining();
          await terminateLiveSubagentsForShutdown(resolveGatewayContext);
          resetGatewayWorkAdmission();
          for (const { runId, token } of claims) {
            releaseAgentRunContext(runId, token);
            expect(subagentRuns.get(runId)).toMatchObject({
              execution: {
                status: "terminal",
                outcome: { status: "error", error: "Gateway stopped" },
              },
              collectorCompletion: { status: "failed" },
            });
            expect(subagentRuns.get(runId)?.killReconciliation).toBeUndefined();
          }
          await resetSubagentRegistryForTests({ persist: false });
          await restore();
        }
        const tool = createAgentsWaitTool({
          agentSessionKey: "agent:main:main",
          agentId: "main",
          config: { tools: { swarm: true } },
        });
        const args = { ids: entries.map((entry) => entry.runId), awaitResults: true };
        const signal = AbortSignal.timeout(1500);
        const waiting = tool.execute("wait", args, signal);
        await testing.sweepOnceForTests();
        const expected = {
          completed: [
            { runId: "captured", status: "done", result: "saved result" },
            ...entries.slice(1).map((entry) => ({
              runId: entry.runId,
              status: "failed",
              error: expect.stringMatching(/restart|Gateway stopped/),
            })),
          ],
          pending: [],
        };
        expect((await waiting).details).toMatchObject(expected);
        // A late waiter must read the durable result without a new completion event.
        expect((await tool.execute("late-wait", args, signal)).details).toMatchObject(expected);
        for (const entry of entries) {
          expect(subagentRuns.isCompletionAuthorityRetired(subagentRuns.get(entry.runId)!)).toBe(
            true,
          );
        }
      } finally {
        resetGatewayWorkAdmission();
        for (const { runId, token } of claims) {
          releaseAgentRunContext(runId, token);
        }
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  },
);
