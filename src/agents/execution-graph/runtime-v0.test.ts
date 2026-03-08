import { describe, expect, it, vi } from "vitest";
import { runExecutionGraphV0 } from "./runtime-v0.js";
import { createInMemoryExecutionGraphStateStoreV0 } from "./state-store-v0.js";

describe("runExecutionGraphV0", () => {
  it("replays succeeded nodes deterministically on resume", async () => {
    const store = createInMemoryExecutionGraphStateStoreV0();
    const calls = { one: 0, two: 0 };

    const runOnce = async () =>
      await runExecutionGraphV0({
        graphId: "g1",
        runId: "run-1",
        planVersion: "plan-v0",
        graphInputs: { mode: "test" },
        context: {},
        stateStore: store,
        nodes: [
          {
            id: "one",
            run: async () => {
              calls.one += 1;
              return { value: "a" };
            },
          },
          {
            id: "two",
            deps: ["one"],
            run: async ({ depOutputs }) => {
              calls.two += 1;
              return `${String((depOutputs.one as { value: string }).value)}-b`;
            },
          },
        ],
      });

    const first = await runOnce();
    expect(first.status).toBe("ok");
    expect(calls).toEqual({ one: 1, two: 1 });

    const second = await runOnce();
    expect(second.status).toBe("ok");
    expect(calls).toEqual({ one: 1, two: 1 });
    expect(second.resumed).toBe(true);
  });

  it("resumes from failed node and skips already-succeeded prerequisites", async () => {
    const store = createInMemoryExecutionGraphStateStoreV0();
    const calls = { prep: 0, flaky: 0 };
    let failOnce = true;

    const run = async () =>
      await runExecutionGraphV0({
        graphId: "g2",
        runId: "run-2",
        planVersion: "plan-v0",
        graphInputs: { mode: "retry" },
        context: {},
        stateStore: store,
        nodes: [
          {
            id: "prep",
            run: async () => {
              calls.prep += 1;
              return { ok: true };
            },
          },
          {
            id: "flaky",
            deps: ["prep"],
            run: async () => {
              calls.flaky += 1;
              if (failOnce) {
                failOnce = false;
                throw new Error("boom");
              }
              return { ok: true };
            },
          },
        ],
      });

    const first = await run();
    expect(first.status).toBe("failed");
    expect(first.failedNodeId).toBe("flaky");
    expect(calls).toEqual({ prep: 1, flaky: 1 });

    const second = await run();
    expect(second.status).toBe("ok");
    expect(calls).toEqual({ prep: 1, flaky: 2 });
    expect(second.run.nodeStates.prep?.status).toBe("succeeded");
    expect(second.run.nodeStates.flaky?.status).toBe("succeeded");
    expect(second.run.nodeStates.flaky?.errorTrace).toBeUndefined();
  });

  it("records required persisted node fields", async () => {
    const store = createInMemoryExecutionGraphStateStoreV0();

    const now = vi.fn();
    now.mockReturnValueOnce(10); // createdAt
    now.mockReturnValueOnce(10); // updatedAt init
    now.mockReturnValueOnce(11); // running
    now.mockReturnValueOnce(12); // run.updatedAt while running
    now.mockReturnValueOnce(13); // complete
    now.mockReturnValueOnce(14); // run.updatedAt complete

    const result = await runExecutionGraphV0({
      graphId: "g3",
      runId: "run-3",
      planVersion: "plan-v0",
      graphInputs: { value: 1 },
      context: {},
      stateStore: store,
      nowMs: now,
      nodes: [{ id: "n1", run: async () => ({ done: true }) }],
    });

    expect(result.status).toBe("ok");
    const node = result.run.nodeStates.n1;
    expect(node).toBeDefined();
    expect(node?.status).toBe("succeeded");
    expect(node?.planVersion).toBe("plan-v0");
    expect(typeof node?.inputsHash).toBe("string");
    expect(node?.inputsHash.length).toBe(64);
    expect(typeof node?.outputsSummary).toBe("string");
    expect(node?.errorTrace).toBeUndefined();
  });
});
