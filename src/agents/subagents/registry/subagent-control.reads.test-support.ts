import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerControlledSubagentReadTests(
  addRun: (overrides: SubagentRunRecordOverrides) => Promise<SubagentRunRecord>,
) {
  const root = "agent:main:main";
  const add = (id: string, owner = root, overrides: Partial<SubagentRunRecordOverrides> = {}) => {
    const now = Date.now();
    return addRun({
      runId: `run-${id}`,
      childSessionKey: `agent:main:subagent:${id}`,
      controllerSessionKey: owner,
      requesterSessionKey: owner,
      requesterDisplayKey: overrides.requesterSessionKey ?? owner,
      createdAt: now - 500,
      startedAt: now,
      ...overrides,
    });
  };
  const peer = "agent:main:telegram:direct:abc123";
  it.each<[string, string, string, number]>([
    ["control owner", root, peer, 1],
    ["completion owner", peer, root, 1],
    ["unrelated session", "agent:other:discord:direct:xyz", "agent:other:main", 0],
  ])(
    "applies read visibility for the %s",
    async (_name, controllerSessionKey, requesterSessionKey, expectedCount) => {
      const childSessionKey = "agent:main:subagent:list-visibility";
      await add("list-visibility", controllerSessionKey, { requesterSessionKey });

      const { runs: results } = await buildControlledSubagentRunsReadContext("agent:main:main");
      expect(results).toHaveLength(expectedCount);
      if (expectedCount === 1) {
        expect(results[0]?.childSessionKey).toBe(childSessionKey);
      }
    },
  );

  it("uses one stable snapshot for listing and descendant counts", async () => {
    const now = Date.now();
    const parentSessionKey = "agent:main:subagent:status-parent";
    await add("status-parent", root, {
      createdAt: now - 4_000,
      startedAt: now - 3_500,
      endedAt: now - 3_000,
    });
    const addChild = (id: number, startedAt: number) =>
      add(`status-child-${id}`, parentSessionKey, {
        childSessionKey: `${parentSessionKey}:subagent:child-${id}`,
        createdAt: startedAt - 500,
        startedAt,
      });
    await addChild(1, now - 1_500);

    const context = await buildControlledSubagentRunsReadContext(root);

    await addChild(2, now - 500);

    expect(context.runs.map((run) => run.runId)).toEqual(["run-status-parent"]);
    expect(context.list.pendingDescendants.get(parentSessionKey)).toBe(1);
    expect(
      (await buildControlledSubagentRunsReadContext(root)).list.pendingDescendants.get(
        parentSessionKey,
      ),
    ).toBe(2);
  });

  it("partitions duplicate bare controller keys by owning agent", async () => {
    const now = Date.now();
    for (const agentId of ["research", "ops"]) {
      await add(agentId, "global", {
        childSessionKey: `agent:${agentId}:subagent:child`,
        requesterAgentId: agentId,
        createdAt: now,
        startedAt: now,
      });
    }

    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
    };
    const context = await buildControlledSubagentRunsReadContext("global", "research", cfg);
    expect(context.runs.map((run) => run.runId)).toEqual(["run-research"]);
  });
}
