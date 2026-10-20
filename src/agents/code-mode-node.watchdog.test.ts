import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { expect, it } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { setTrackedWorkerGcObserver } from "../infra/worker-cpu.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { codeModeNodeInitialization, prepareCodeModeNodeCatalog } from "./code-mode-node-input.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import type {
  CodeModeNodeInput,
  CodeModeWorkerThreadResult,
  SettledBridgeRequest,
} from "./code-mode-worker-types.js";

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
function run(
  pool: Pool,
  input:
    | { kind: "exec"; source: string }
    | { kind: "resume"; settledRequests: SettledBridgeRequest[] },
  progress = new CodeModeNodeProgress(config.maxOutputBytes),
) {
  const common = { config, inlineHost: false, progress: progress.buffer };
  return pool.run(
    input.kind === "exec" ? { ...common, ...input, initialization } : { ...common, ...input },
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
          await run(pool, {
            kind: "exec",
            source:
              "const data = Array.from({ length: 10000 }, (_, i) => ({ i })); return data.length;",
          }),
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
    const initial = await run(pool, {
      kind: "exec",
      source:
        "const data = new Array(5 * 1024 * 1024).fill(1); await yield_control(); return data.length;",
    });
    if (initial.status !== "waiting") {
      throw new Error(JSON.stringify(initial));
    }
    // Observe the native idle path; natural V8 collections are allowed and are not counted.
    port1.postMessage(null);
    expect(await observed).toEqual([0]);
    expect(
      await run(pool, {
        kind: "resume",
        settledRequests: initial.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
      }),
    ).toMatchObject({ status: "completed", value: { json: "5242880" } });
    expect(await run(pool, { kind: "exec", source: "return 42;" })).toMatchObject({
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
        const result = await run(pool, { kind: "exec", source: "return watchdogThreads();" });
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
    const initial = await run(
      pool,
      {
        kind: "exec",
        source:
          'text("before"); await yield_control(); text("after"); await yield_control(); return 0;',
      },
      originalProgress,
    );
    if (initial.status !== "waiting") {
      throw new Error(JSON.stringify(initial));
    }
    expect(initial.output).toEqual(before);
    const resumed = await run(
      pool,
      {
        kind: "resume",
        settledRequests: initial.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
      },
      resumedProgress,
    );
    expect(resumed).toMatchObject({ status: "waiting", output: after });
    expect(resumedProgress.output()).toEqual(after);
    expect(originalProgress.output()).toEqual(before);
  } finally {
    await pool.close();
  }
});
