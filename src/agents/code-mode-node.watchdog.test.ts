import { expect, it } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import type { CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

const config = {
  timeoutMs: 5_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 1024,
  maxPendingToolCalls: 16,
  maxSnapshotBytes: 1024,
};

it.skipIf(process.platform !== "linux")(
  "runs cells without per-evaluation native threads",
  async () => {
    const pool = new WorkerTaskPool<unknown, CodeModeWorkerThreadResult<undefined>>({
      workerUrl: new URL("./code-mode-node.watchdog.test-support.ts", import.meta.url),
      maxWorkers: 1,
    });
    try {
      for (let index = 0; index < 20; index++) {
        const result = await pool.run(
          {
            kind: "exec",
            source: "return watchdogThreads();",
            config,
            progress: new CodeModeNodeProgress(1024).buffer,
            inlineHost: false,
            catalog: [],
            namespaces: [],
          },
          { timeoutMs: 5_000 },
        );
        expect(result).toMatchObject({
          status: "completed",
          value: { kind: "complete", json: "[]" },
        });
      }
    } finally {
      await pool.close();
    }
  },
);

it("publishes resumed output only to its fresh interruption buffer", async () => {
  const pool = new WorkerTaskPool<unknown, CodeModeWorkerThreadResult<undefined>>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("codeModeNode"),
    // The parked cell belongs to this worker; its resume must retain that custody.
    maxWorkers: 1,
  });
  const before = {
    count: 1,
    source: { kind: "complete", json: '[{"type":"text","text":"before"}]' },
  };
  const after = {
    count: 1,
    source: { kind: "complete", json: '[{"type":"text","text":"after"}]' },
  };
  const originalProgress = new CodeModeNodeProgress(config.maxOutputBytes);
  const resumedProgress = new CodeModeNodeProgress(config.maxOutputBytes);
  try {
    const initial = await pool.run(
      {
        kind: "exec",
        source:
          'text("before"); await yield_control(); text("after"); await yield_control(); return 0;',
        config,
        progress: originalProgress.buffer,
        inlineHost: false,
        catalog: [],
        namespaces: [],
      },
      { timeoutMs: config.timeoutMs },
    );
    if (initial.status !== "waiting") {
      throw new Error(JSON.stringify(initial));
    }
    expect(initial.output).toEqual(before);
    const resumed = await pool.run(
      {
        kind: "resume",
        config,
        progress: resumedProgress.buffer,
        inlineHost: false,
        settledRequests: initial.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
      },
      { timeoutMs: config.timeoutMs },
    );
    expect(resumed).toMatchObject({ status: "waiting", output: after });
    expect(resumedProgress.output()).toEqual(after);
    expect(originalProgress.output()).toEqual(before);
  } finally {
    await pool.close();
  }
});
