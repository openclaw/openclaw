import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { expect, it, onTestFinished } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { setTrackedWorkerGcObserver } from "../infra/worker-cpu.js";
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

type Pool = WorkerTaskPool<CodeModeNodeInput, CodeModeWorkerThreadResult<undefined>>;
function poolFor(workerUrl = resolveRuntimeProcessEntrypointUrl("codeModeNode")): Pool {
  // A parked cell and its resume must retain custody of the same worker.
  const pool: Pool = new WorkerTaskPool({ workerUrl, maxWorkers: 1 });
  onTestFinished(() => pool.close());
  return pool;
}

function run(
  pool: Pool,
  input: string | CodeModeWorkerThreadResult<undefined>,
  progress = new CodeModeNodeProgress(config.maxOutputBytes),
) {
  const common = { config, inlineHost: false, progress: progress.buffer };
  if (typeof input !== "string" && input.status !== "waiting") {
    throw new Error(JSON.stringify(input));
  }
  return pool.run(
    typeof input === "string"
      ? { ...common, kind: "exec", source: input, initialization }
      : {
          ...common,
          kind: "resume",
          settledRequests: input.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
        },
    { timeoutMs: config.timeoutMs },
  );
}

function gcPool(port: MessagePort, old: number, young: number) {
  return new WorkerTaskPool<CodeModeNodeInput, CodeModeWorkerThreadResult<undefined>>({
    workerUrl: new URL("./code-mode-node-idle-gc.test-support.ts", import.meta.url),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: old, maxYoungGenerationSizeMb: young },
      workerData: { receipt: port },
      transferList: [port],
    },
  });
}

// The real idle interval is intentional: fake clocks cannot exercise V8's GC
// scheduling. Keep this one-minute regression out of local performance sweeps.
it.skipIf(Boolean(process.versions.bun))(
  "keeps a Code Mode worker idle after cells without per-GC event-loop work",
  async () => {
    const { port1, port2 } = new MessageChannel();
    const pool = gcPool(port2, 384, 8);
    setTrackedWorkerGcObserver(() => {});
    try {
      for (let index = 0; index < 16; index++) {
        expect(
          await run(
            pool,
            "const data = Array.from({ length: 10000 }, (_, i) => ({ i })); return data.length;",
          ),
        ).toMatchObject({ status: "completed", value: { json: "10000" } });
      }
      const observed = once(port1, "message");
      port1.postMessage("observe-idle");
      const [sample] = await observed;
      expect(sample.immediates).toBe(0);
      expect(sample.majorCollections).toBeGreaterThan(0);
      expect(sample.majorCollections).toBeLessThan(10);
    } finally {
      setTrackedWorkerGcObserver(undefined);
      port1.close();
      port2.close();
      await pool.close();
    }
  },
  75_000,
);

it("does not force full collections in a reusable Code Mode worker", async () => {
  const { port1, port2 } = new MessageChannel();
  const observed = once(port1, "message");
  const pool = gcPool(port2, 128, 4);
  try {
    const initial = await run(
      pool,
      "const data = new Array(5 * 1024 * 1024).fill(1); await yield_control(); return data.length;",
    );
    expect(initial.status).toBe("waiting");
    // Observe the native idle path; natural V8 collections are allowed and are not counted.
    port1.postMessage(null);
    expect(await observed).toEqual([0]);
    expect(await run(pool, initial)).toMatchObject({
      status: "completed",
      value: { json: "5242880" },
    });
    expect(await run(pool, "return 42;")).toMatchObject({
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
    const pool = poolFor(new URL("./code-mode-node.watchdog.test-support.ts", import.meta.url));
    for (let index = 0; index < 20; index++) {
      expect(await run(pool, "return watchdogThreads();")).toMatchObject({
        status: "completed",
        value: { kind: "complete", json: "[]" },
      });
    }
  },
);

it("publishes resumed output only to its fresh interruption buffer", async () => {
  const pool = poolFor();
  const output = (text: string) => ({
    count: 1,
    source: { kind: "complete", json: JSON.stringify([{ type: "text", text }]) },
  });
  const before = output("before");
  const after = output("after");
  const originalProgress = new CodeModeNodeProgress(config.maxOutputBytes);
  const resumedProgress = new CodeModeNodeProgress(config.maxOutputBytes);
  const initial = await run(
    pool,
    'text("before"); await yield_control(); text("after"); await yield_control(); return 0;',
    originalProgress,
  );
  expect(initial.output).toEqual(before);
  const resumed = await run(pool, initial, resumedProgress);
  expect(resumed).toMatchObject({ status: "waiting", output: after });
  expect(resumedProgress.output()).toEqual(after);
  expect(originalProgress.output()).toEqual(before);
});
