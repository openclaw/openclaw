import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { codeModeNodeInitialization, prepareCodeModeNodeCatalog } from "./code-mode-node-input.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import type { CodeModeNodeInput, CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

const initialization = prepareCodeModeNodeCatalog({ catalog: [], namespaces: [] })[
  codeModeNodeInitialization
];

const config = {
  timeoutMs: 5_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 1024,
  maxPendingToolCalls: 16,
  maxSnapshotBytes: 1024,
};

it("does not force full collections in a reusable Code Mode worker", async () => {
  const { port1, port2 } = new MessageChannel();
  const observed = once(port1, "message");
  const pool = new WorkerTaskPool<CodeModeNodeInput, CodeModeWorkerThreadResult<undefined>>({
    workerUrl: new URL("./code-mode-node-idle-gc.test-support.ts", import.meta.url),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 4 },
      workerData: { receipt: port2 },
      transferList: [port2],
    },
  });
  const run = (source: string) =>
    pool.run(
      {
        kind: "exec",
        source,
        config,
        initialization,
        inlineHost: false,
        progress: new CodeModeNodeProgress(config.maxOutputBytes).buffer,
      },
      { timeoutMs: 5000 },
    );
  try {
    const initial = await run(
      "const data = new Array(5 * 1024 * 1024).fill(1); await yield_control(); return data.length;",
    );
    if (initial.status !== "waiting") {
      throw new Error(JSON.stringify(initial));
    }
    // Observe the native idle path; natural V8 collections are allowed and are not counted.
    port1.postMessage(null);
    expect(await observed).toEqual([0]);
    expect(
      await pool.run(
        {
          kind: "resume",
          config,
          progress: new CodeModeNodeProgress(config.maxOutputBytes).buffer,
          inlineHost: false,
          settledRequests: initial.pendingRequests.map(({ id }) => ({
            id,
            ok: true,
            json: "null",
          })),
        },
        { timeoutMs: config.timeoutMs },
      ),
    ).toMatchObject({ status: "completed", value: { json: "5242880" } });
    expect(await run("return 42;")).toMatchObject({
      status: "completed",
      value: { json: "42" },
    });
  } finally {
    port1.close();
    port2.close();
    await pool.close();
  }
});

it.skipIf(process.platform !== "linux")(
  "runs cells without per-evaluation native threads",
  async () => {
    const pool = new WorkerTaskPool<CodeModeNodeInput, CodeModeWorkerThreadResult<undefined>>({
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
            initialization,
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
  const pool = new WorkerTaskPool<CodeModeNodeInput, CodeModeWorkerThreadResult<undefined>>({
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
        initialization,
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
