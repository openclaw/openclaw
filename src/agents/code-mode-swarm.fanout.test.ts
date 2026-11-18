import { afterEach, assert, describe, expect, it } from "vitest";
import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import { resolveCodeModeConfig } from "./code-mode.js";
import { resetCodeModeTestState, testing } from "./code-mode.test-support.js";

afterEach(resetCodeModeTestState);
type Input = Parameters<typeof testing.runCodeModeExecutor>[0];
type Resume = Extract<Input, { kind: "resume" }>;
function createExecutor(limit: number) {
  const config = resolveCodeModeConfig({
    tools: { codeMode: { enabled: true, maxPendingToolCalls: limit } },
  });
  const run = (input: Input) =>
    testing.runCodeModeExecutor(input, { timeoutMs: 10_000, executor: config.executor });
  const initialization = { config, apiFiles: [], namespaces: [], swarmEnabled: true };
  return {
    exec: (source: string, catalog: unknown[] = []) =>
      run({ kind: "exec", source, catalog, ...initialization }),
    resume: (
      continuation: Resume["continuation"],
      settledRequests: Resume["settledRequests"],
      pendingRequests?: Resume["pendingRequests"],
    ) => run({ kind: "resume", config, continuation, settledRequests, pendingRequests }),
  };
}

describe("Swarm pipeline backpressure", () => {
  it("settles a partial two-stage pipeline with a failed child and follow-up tools", async () => {
    const limit = 3;
    const count = 4;
    const executor = createExecutor(limit);
    const source = `
    const collecting = Promise.allSettled(Array.from({ length: ${count} }, async (_, index) => {
      const next = await agents.run("first-" + index, { phase: "First" });
      await progress({ value: index });
      return await agents.run(next, { phase: "Second" });
    }));
    const outcomes = await collecting;
    return outcomes.map(outcome => outcome.status === "fulfilled"
      ? { status: outcome.status, value: outcome.value }
      : { status: outcome.status, error: outcome.reason.message });
  `;
    let result: CodeModeWorkerResult = await executor.exec(source, [
      { callableName: "progress", name: "progress", source: "openclaw" },
    ]);
    const collectors = new Map<string, string>();
    const progressItems: unknown[] = [];
    for (let round = 0; result.status === "waiting" && round < count * 8; round++) {
      expect(result.pendingRequests.length).toBeGreaterThan(0);
      expect(result.pendingRequests.length).toBeLessThanOrEqual(limit);
      const frontier = result.pendingRequests.slice(-1);
      const pendingRequests = result.pendingRequests.slice(0, -1);
      const settledRequests = frontier.map((request) => {
        let value: unknown;
        if (request.method === "swarmNote") {
          value = { ok: true };
        } else if (request.method === "agentSpawn") {
          const prompt = request.args[0];
          assert(typeof prompt === "string", "expected a collector prompt");
          const runId = `collector-${collectors.size}`;
          collectors.set(runId, prompt);
          value = { status: "accepted", runId };
        } else if (request.method === "callValue") {
          expect(request.args[0]).toBe("progress");
          progressItems.push(request.args[1]);
          value = { recorded: true };
        } else {
          expect(request.method).toBe("agentWait");
          const runId = request.args[0];
          const prompt = typeof runId === "string" ? collectors.get(runId) : undefined;
          assert(prompt, "wait must reference an accepted collector");
          const nextStage = prompt.startsWith("first-")
            ? prompt.replace("first-", "second-")
            : prompt.replace("second-", "done-");
          value =
            prompt === "first-1"
              ? { runId, status: "failed", error: "child intentionally failed" }
              : { runId, status: "done", result: nextStage };
        }
        return { id: request.id, ok: true as const, json: JSON.stringify(value) };
      });
      result = await executor.resume(result.continuation, settledRequests, pendingRequests);
    }
    assert(
      result.status === "completed",
      result.status === "failed" ? result.error : "pipeline must complete",
    );
    expect(result.value.kind).toBe("complete");
    expect(JSON.parse(result.value.json)).toEqual(
      Array.from({ length: count }, (_, index) =>
        index === 1
          ? { status: "rejected", error: expect.stringContaining("child intentionally failed") }
          : { status: "fulfilled", value: `done-${index}` },
      ),
    );
    const spawnedPrompts = [...collectors.values()];
    expect(spawnedPrompts).toHaveLength(count * 2 - 1);
    expect(new Set(spawnedPrompts).size).toBe(spawnedPrompts.length);
    expect(progressItems).toEqual(
      expect.arrayContaining([{ value: 0 }, { value: 2 }, { value: 3 }]),
    );
  });

  it("preserves queued collector arguments and structured results", async () => {
    const executor = createExecutor(1);
    const options = { label: "original", schema: { type: "object" } };
    let result = await executor.exec(`
          const options = { label: "original", schema: { type: "object" } };
          const collector = agents.run("Queued research", options);
          options.label = "changed";
          delete options.schema;
          return await collector;
        `);
    expect(result).toMatchObject({
      status: "waiting",
      pendingRequests: [
        {
          method: "agentSpawn",
          args: ["Queued research", options],
        },
      ],
    });
    for (let round = 0; result.status === "waiting" && round < 2; round++) {
      const settledRequests = result.pendingRequests.map((request) => ({
        id: request.id,
        ok: true as const,
        json: JSON.stringify(
          request.method === "agentSpawn"
            ? { runId: "collector" }
            : {
                runId: "collector",
                status: "done",
                result: "text",
                structured: { answer: 42 },
              },
        ),
      }));
      result = await executor.resume(result.continuation, settledRequests);
    }
    assert(result.status === "completed", "collector must complete");
    expect(JSON.parse(result.value.json)).toEqual({ answer: 42 });
  });
});
