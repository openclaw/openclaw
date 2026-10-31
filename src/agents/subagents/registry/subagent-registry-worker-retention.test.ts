import { randomBytes } from "node:crypto";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { getSubagentActivationRuns, subagentRuns } from "./subagent-registry-memory.js";
import { prepareSubagentRunsSnapshotForRunIds } from "./subagent-registry-state.js";
import {
  change,
  entry,
  register,
  restore,
  stored,
  useSubagentRegistryWorkerFixture,
} from "./subagent-registry-worker.test-support.js";

useSubagentRegistryWorkerFixture();

it.each(["0", "1"])(
  "releases completed payloads and persists their removal (catalog=%s)",
  async (readPersisted) => {
    vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", readPersisted);
    const gc = async () => {
      const inspector = new Session();
      inspector.connect();
      try {
        await inspector.post("HeapProfiler.collectGarbage");
      } finally {
        inspector.disconnect();
      }
    };
    await register(entry("warm-retention"));
    await setImmediate();
    await gc();
    const before = process.memoryUsage().heapUsed;
    // Independent flat strings expose sliced-preview and full-row cache retention.
    for (let batch = 0; batch < 4; batch++) {
      await register(
        ...Array.from({ length: 16 }, (_, index) => {
          const resultText = randomBytes(96 * 1024).toString("base64");
          return entry(`retained-${batch * 16 + index}`, {
            // A short-task row also catches equality-elided payload removal after compaction.
            task:
              batch === 0 && index === 1 ? "short task" : randomBytes(96 * 1024).toString("base64"),
            execution: {
              status: "terminal" as const,
              endedAt: 2,
              outcome: { status: "ok" as const },
            },
            cleanupCompletedAt: 3,
            completion: {
              required: false,
              resultText,
              fallbackResultText: "retained fallback",
              terminalReply: { disposition: "visible" as const, text: resultText.slice(0, 4096) },
            },
          });
        }),
      );
    }
    await setImmediate();
    await gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(6 * 1024 * 1024);
    expect(subagentRuns.get("retained-0")?.task.length).toBeLessThanOrEqual(160);
    expect(subagentRuns.get("retained-0")?.completion?.resultText).toBeUndefined();

    const prepared = await prepareSubagentRunsSnapshotForRunIds(subagentRuns, ["retained-0"]);
    const full = prepared.consume((rows) => rows.get("retained-0"));
    expect(full.ready).toBe(true);
    if (!full.ready) {
      throw new Error("Expected a current completed run");
    }
    expect(full.value?.task).toHaveLength(128 * 1024);
    expect(full.value?.completion?.resultText).toHaveLength(128 * 1024);
    expect(full.value?.completion?.terminalReply).toEqual({
      disposition: "visible",
      text: full.value?.completion?.resultText?.slice(0, 4096),
    });
    await change("retained-0", { label: "updated after completion" });
    const durable = stored("retained-0");
    expect(durable?.task).toBe(full.value?.task);
    expect(durable?.completion?.resultText).toBe(full.value?.completion?.resultText);
    expect(durable?.completion?.terminalReply).toEqual(full.value?.completion?.terminalReply);
    expect(durable?.label).toBe("updated after completion");
    subagentRuns.clear();
    await restore();
    expect(subagentRuns.get("retained-0")?.task.length).toBeLessThanOrEqual(160);
    expect(subagentRuns.get("retained-0")?.completion?.resultText).toBeUndefined();
    const restarted = await prepareSubagentRunsSnapshotForRunIds(subagentRuns, ["retained-0"]);
    expect(restarted.consume((rows) => rows.get("retained-0")?.completion)).toEqual({
      ready: true,
      value: durable?.completion,
    });
    const resident = subagentRuns.get("retained-1");
    expect(resident?.task).toBe("short task");
    expect(resident?.completion?.resultText).toBeUndefined();
    expect(resident?.completion?.fallbackResultText).toBeUndefined();
    await change("retained-1", (row) => {
      delete row.completion!.resultText;
      delete row.completion!.fallbackResultText;
      delete row.completion!.terminalReply;
    });
    const cleared = stored("retained-1");
    expect(cleared).toBeDefined();
    expect(cleared?.completion?.resultText).toBeUndefined();
    expect(cleared?.completion?.fallbackResultText).toBeUndefined();
    expect(cleared?.completion?.terminalReply).toBeUndefined();
  },
);

it("hydrates settled payloads for metadata mutation", async () => {
  const terminalReply = {
    disposition: "visible" as const,
    text: "The completed child result",
    modelRouteChange: "The runtime selected the fallback model.",
  };
  const child = entry("settled-metadata", {
    execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
    cleanupCompletedAt: 3,
    expectsCompletionMessage: true,
    completion: { required: true, resultText: terminalReply.text, terminalReply },
    delivery: {
      status: "delivered",
      payload: {
        requesterSessionKey: "agent:main:requester",
        requesterDisplayKey: "original requester",
        childSessionKey: "agent:main:subagent:settled-metadata",
        childRunId: "settled-metadata",
        task: "Original delivery task",
        terminalReply,
      },
    },
  });
  await register(child);
  expect([...getSubagentActivationRuns(subagentRuns)]).toEqual([]);

  await change(child.runId, (row) => {
    expect(row.completion?.terminalReply).toEqual(terminalReply);
    expect(row.delivery?.payload).toEqual(child.delivery?.payload);
    row.label = "Updated after completion";
  });
  const durable = stored(child.runId);
  expect(durable?.completion?.terminalReply).toEqual(terminalReply);
  expect(durable?.delivery?.payload).toEqual(child.delivery?.payload);
  expect(durable?.label).toBe("Updated after completion");
});
