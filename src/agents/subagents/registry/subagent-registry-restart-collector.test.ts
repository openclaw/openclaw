import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { initSubagentRegistry } from "./subagent-registry.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

it("settles an already stopped collector when the registry restores", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      await resetSubagentRegistryForTests({ persist: false });
      try {
        await captureRuntimeConfigAsyncReader()();
        const now = Date.now();
        const run = createSubagentRunRecord({
          runId: "stopped-collector",
          childAgentId: "main",
          childSessionKey: "agent:main:subagent:stopped-collector",
          childSessionIdentity: { sessionId: "child-id", lifecycleRevision: "child-revision" },
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          swarmRequesterSessionKey: "agent:main:main",
          collect: true,
          expectsCompletionMessage: false,
          createdAt: now - 1_000,
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          execution: {
            status: "terminal",
            startedAt: now - 900,
            endedAt: now - 500,
            outcome: { status: "error", error: "Gateway stopped" },
          },
        });
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        await initSubagentRegistry();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.collectorCompletion).toEqual({
          status: "killed",
        });
        const tool = createAgentsWaitTool({
          agentSessionKey: "agent:main:main",
          agentId: "main",
          config: { tools: { swarm: true } },
        });
        const response = await tool.execute("wait", { ids: [run.runId], timeoutSeconds: 0 });
        expect(response.details).toMatchObject({
          completed: [{ runId: run.runId, status: "killed", error: "Gateway stopped" }],
          pending: [],
        });
      } finally {
        await resetSubagentRegistryForTests({ persist: false });
      }
    },
  );
});
