import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerControlledSubagentReadTests(
  addRun: (overrides: SubagentRunRecordOverrides) => Promise<SubagentRunRecord>,
) {
  const addOwnedRun = (
    runId: string,
    childSessionKey: string,
    owner: string,
    startedAt: number,
    overrides: Partial<SubagentRunRecordOverrides> = {},
  ) =>
    addRun({
      runId,
      childSessionKey,
      controllerSessionKey: owner,
      requesterSessionKey: owner,
      requesterDisplayKey: overrides.requesterSessionKey ?? owner,
      createdAt: startedAt - 500,
      startedAt,
      ...overrides,
    });
  describe("controlled subagent reads", () => {
    const root = "agent:main:main";
    const peer = "agent:main:telegram:direct:abc123";
    it.each<[string, string, string, number]>([
      ["control owner", root, peer, 1],
      ["completion owner", peer, root, 1],
      ["unrelated session", "agent:other:discord:direct:xyz", "agent:other:main", 0],
    ])(
      "applies read visibility for the %s",
      async (_name, controllerSessionKey, requesterSessionKey, expectedCount) => {
        const childSessionKey = "agent:main:subagent:list-visibility";
        await addOwnedRun(
          "run-list-visibility",
          childSessionKey,
          controllerSessionKey,
          Date.now(),
          { requesterSessionKey },
        );

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
      await addOwnedRun("run-status-parent", parentSessionKey, rootSessionKey, now - 3_500, {
        endedAt: now - 3_000,
      });
      const addChild = (id: number, startedAt: number) =>
        addOwnedRun(
          `run-status-child-${id}`,
          `${parentSessionKey}:subagent:child-${id}`,
          parentSessionKey,
          startedAt,
        );
      await addChild(1, now - 1_500);

      const context = await buildControlledSubagentRunsReadContext(rootSessionKey);

      await addChild(2, now - 500);

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
        await addOwnedRun(`run-${agentId}`, `agent:${agentId}:subagent:child`, "global", now, {
          requesterAgentId: agentId,
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
