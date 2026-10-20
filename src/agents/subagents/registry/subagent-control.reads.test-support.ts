import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerControlledSubagentReadTests(
  addRun: (overrides: SubagentRunRecordOverrides) => Promise<SubagentRunRecord>,
) {
  describe("controlled subagent reads", () => {
    it.each([
      {
        name: "control owner",
        controllerSessionKey: "agent:main:main",
        requesterSessionKey: "agent:main:telegram:direct:abc123",
        expectedCount: 1,
      },
      {
        name: "completion owner",
        controllerSessionKey: "agent:main:telegram:direct:abc123",
        requesterSessionKey: "agent:main:main",
        expectedCount: 1,
      },
      {
        name: "unrelated session",
        controllerSessionKey: "agent:other:discord:direct:xyz",
        requesterSessionKey: "agent:other:main",
        expectedCount: 0,
      },
    ])(
      "applies read visibility for the $name",
      async ({ controllerSessionKey, requesterSessionKey, expectedCount }) => {
        const childSessionKey = "agent:main:subagent:list-visibility";
        await addRun({
          runId: "run-list-visibility",
          childSessionKey,
          controllerSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          task: "visibility test",
          createdAt: Date.now(),
          startedAt: Date.now(),
        });

        const { runs: results } = await buildControlledSubagentRunsReadContext("agent:main:main");
        expect(results).toHaveLength(expectedCount);
        if (expectedCount === 1) {
          expect(results[0]?.childSessionKey).toBe(childSessionKey);
        }
      },
    );

    it("uses one stable snapshot for listing and descendant counts", async () => {
      const now = Date.now();
      const rootSessionKey = "agent:main:main";
      const parentSessionKey = "agent:main:subagent:status-parent";
      await addRun({
        runId: "run-status-parent",
        childSessionKey: parentSessionKey,
        controllerSessionKey: rootSessionKey,
        requesterSessionKey: rootSessionKey,
        requesterDisplayKey: rootSessionKey,
        task: "status parent",
        createdAt: now - 4_000,
        startedAt: now - 3_500,
        endedAt: now - 3_000,
      });
      await addRun({
        runId: "run-status-child-1",
        childSessionKey: `${parentSessionKey}:subagent:child-1`,
        controllerSessionKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        requesterDisplayKey: parentSessionKey,
        task: "status child 1",
        createdAt: now - 2_000,
        startedAt: now - 1_500,
      });

      const context = await buildControlledSubagentRunsReadContext(rootSessionKey);

      await addRun({
        runId: "run-status-child-2",
        childSessionKey: `${parentSessionKey}:subagent:child-2`,
        controllerSessionKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        requesterDisplayKey: parentSessionKey,
        task: "status child 2",
        createdAt: now - 1_000,
        startedAt: now - 500,
      });

      expect(context.runs.map((run) => run.runId)).toEqual(["run-status-parent"]);
      expect(context.list.pendingDescendants.get(parentSessionKey)).toBe(1);
      expect(
        (await buildControlledSubagentRunsReadContext(rootSessionKey)).list.pendingDescendants.get(
          parentSessionKey,
        ),
      ).toBe(2);
    });

    it("partitions duplicate bare controller keys by owning agent", async () => {
      const now = Date.now();
      for (const agentId of ["research", "ops"]) {
        await addRun({
          runId: `run-${agentId}`,
          childSessionKey: `agent:${agentId}:subagent:child`,
          controllerSessionKey: "global",
          requesterSessionKey: "global",
          requesterAgentId: agentId,
          requesterDisplayKey: "global",
          task: `${agentId} task`,
          createdAt: now,
          startedAt: now,
        });
      }

      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { research: {}, ops: {} },
        },
      } as OpenClawConfig;
      const context = await buildControlledSubagentRunsReadContext("global", "research", cfg);
      expect(context.runs.map((run) => run.runId)).toEqual(["run-research"]);
    });
  });
}
