/// <reference lib="es2024.promise" />
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  CODE_MODE_CONTROLLER_SOURCE,
  EMPTY_CODE_MODE_OUTPUT,
  type CodeModeWorkerResult,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerContinuation,
  type CodeModeOutputSource,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import {
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
  type WorkerTaskResponse,
} from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { EvalFlags, QuickJS, type Snapshot } from "quickjs-wasi";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createQuickJsTestConfig,
  quickJsTestModules as modules,
  runQuickJsExecutor as runCodeModeWorker,
  runQuickJsWire,
} from "./executor.test-support.js";
import { quickJsWorkerTestEntrypoint } from "./worker-entrypoint.test-support.js";

const productionWorkerUrl = resolveRuntimeWorkerUrl(quickJsWorkerTestEntrypoint);
const fixtureExtension = productionWorkerUrl.pathname.endsWith(".ts") ? "ts" : "mjs";
const config = createQuickJsTestConfig();

const sleep = "await new Promise(resolve => setTimeout(resolve, 0));";
type Pool = WorkerTaskPool<unknown, CodeModeWorkerResult>;
type OnRequest = Parameters<Pool["run"]>[1]["onRequest"];
const resolveModule = createRequire(import.meta.url).resolve;

function completeOutput(output: CodeModeOutputSource): unknown[] {
  expect(output.source.kind).toBe("complete");
  const entries: unknown = JSON.parse(output.source.json);
  assert(Array.isArray(entries), "expected complete output entries");
  return entries;
}

function resume(state: CodeModeWorkerBoundary, deadline: number): CodeModeWorkerContinuation {
  return {
    kind: "continue",
    timeoutMs: deadline - performance.now(),
    settledRequests: settled(state),
    pendingRequests: [],
  };
}
function pool(maxWorkers = 1, workerUrl = productionWorkerUrl) {
  const value = new WorkerTaskPool<unknown, CodeModeWorkerResult>({ workerUrl, maxWorkers });
  onTestFinished(() => value.close());
  return value;
}
async function runCell(workers: Pool, source: string, onRequest?: OnRequest, timeoutMs = 15_000) {
  return workers.run({ ...input(source), ...(await modules) }, { timeoutMs, onRequest });
}
async function waitForAbort(...signals: AbortSignal[]) {
  const signal = AbortSignal.any(signals);
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
function expectFailed(result: unknown, code: string, fields: object = {}) {
  expect(result).toMatchObject({ status: "failed", code, ...fields });
}
function expectCompleted(result: unknown, value: object) {
  expect(result).toMatchObject({ status: "completed", value });
}
function boundary(value: unknown): CodeModeWorkerBoundary {
  expect(value).toMatchObject({ status: "boundary" });
  return value as CodeModeWorkerBoundary;
}
function response(
  command: CodeModeWorkerContinuation,
  onConsumed?: () => void,
): WorkerTaskResponse {
  return { input: command, timeoutMs: 10_000, onConsumed };
}
function input(source: string, limits = config) {
  return { kind: "exec" as const, source, config: limits, catalog: [], namespaces: [] };
}

type RunArgs = Parameters<typeof runCodeModeWorker>;
function run(task: RunArgs[0], inlineHost?: RunArgs[4], timeoutMs = 10_000) {
  return runCodeModeWorker(task, timeoutMs, undefined, undefined, inlineHost);
}
function parkedResult(
  result: CodeModeWorkerResult,
): Extract<CodeModeWorkerResult, { status: "waiting" }> {
  assert(result.status === "waiting", "expected a suspended guest");
  return result;
}
function settled(
  state: { pendingRequests: { id: string }[] },
  pendingRequests: readonly { id: string }[] = [],
) {
  return state.pendingRequests
    .filter((request) => !pendingRequests.includes(request))
    .map(({ id }) => ({ id, ok: true, json: "null" }));
}
function restore(
  state: Extract<CodeModeWorkerResult, { status: "waiting" }>,
  pendingRequests: typeof state.pendingRequests = [],
) {
  return {
    kind: "resume" as const,
    config,
    continuation: state.continuation,
    settledRequests: settled(state, pendingRequests),
    pendingRequests,
  };
}

async function executionInput(source: string, kind: "exec" | "resume", limits = config) {
  if (kind === "exec") {
    return input(source, limits);
  }
  const suspended = parkedResult(await run(input(`await yield_control(); ${source}`, limits)));
  return { ...restore(suspended), config: limits };
}

async function instrumentedWorker(prefix: string, source: string) {
  const dir = useAutoCleanupTempDirTracker(onTestFinished).make(prefix);
  const workerPath = path.join(dir, `worker.${fixtureExtension}`);
  const quickJsUrl = pathToFileURL(resolveModule("quickjs-wasi"));
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await writeFile(
    workerPath,
    `
    const { QuickJS } = await import(${JSON.stringify(quickJsUrl.href)});
    ${source}
    await import(${JSON.stringify(productionWorkerUrl.href)});
  `,
  );
  return pathToFileURL(workerPath);
}

type FailureOptions = {
  resumeTimeoutMs?: number;
  prelude?: string;
  rejectBridge?: boolean;
  timeoutMs?: number;
};
type FailureCase = [string, string, string, string, number, FailureOptions?];
const internal = "internal_error";
const yieldControl = "await yield_control();";
const continuationError = 'throw new Error("invalid code mode continuation budget");';

describe("Code Mode worker lifecycle", () => {
  it.each<FailureCase>([
    ["host continuation", yieldControl, "host", internal, 1, { resumeTimeoutMs: Number.NaN }],
    ["guest same-message exception", continuationError, "guest", internal, 0],
    ["host source wrapper", "return true;", "host", internal, 0, { prelude: "}" }],
    ["guest syntax", "return (", "input", "invalid_input", 0],
    ["guest pending promise", "await new Promise(() => {});", "input", "invalid_input", 0],
    ["bridge rejection", yieldControl, "bridge", internal, 1, { rejectBridge: true }],
    [
      "guest deadline",
      `${yieldControl} while (true) {}`,
      "guest",
      "timeout",
      1,
      { resumeTimeoutMs: 30 },
    ],
    ["host admission deadline", "return true;", "host", "timeout", 0, { timeoutMs: 0 }],
  ])(
    "preserves %s failure provenance without replay",
    async (_name, source, phase, code, calls, options = {}) => {
      const onFailure = vi.fn();
      const onBoundary = vi.fn(async (state: CodeModeWorkerBoundary) => ({
        kind: "continue" as const,
        timeoutMs: options.resumeTimeoutMs ?? 1_000,
        pendingRequests: [],
        settledRequests: state.pendingRequests.map(({ id }) => ({
          id,
          ok: options.rejectBridge !== true,
          json: JSON.stringify({ message: "synthetic bridge failure", code: "tool_error" }),
        })),
      }));
      const result = await run(
        {
          ...input(source, { ...config, timeoutMs: options.timeoutMs ?? config.timeoutMs }),
          prelude: options.prelude,
        },
        { onBoundary, onFailure },
      );
      expectFailed(result, code, { failurePhase: phase });
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        phase,
        expect.stringMatching(/^code-mode-quickjs:/),
      );
      expect(onBoundary).toHaveBeenCalledTimes(calls);
    },
  );

  it("preserves legacy snapshot errors without source-location metadata", async () => {
    const { wasmModule: wasm } = await modules;
    let snapshot: Snapshot;
    {
      using vm = await QuickJS.create({ wasm, memoryLimit: config.memoryLimitBytes });
      vm.newFunction("__openclawHostRequest", (_method, _args, id) =>
        vm.newString(id.toString()),
      ).consume((handle) => vm.global.setProp("__openclawHostRequest", handle));
      for (const name of ["__openclawHostCancelRequest", "__openclawHostTakeBridgeReply"]) {
        vm.newFunction(name, () => vm.undefined).consume((handle) =>
          vm.global.setProp(name, handle),
        );
      }
      vm.hostToHandle(config.maxPendingToolCalls).consume((handle) =>
        vm.global.setProp("__openclawMaxPendingToolCalls", handle),
      );
      vm.evalCode(CODE_MODE_CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
      // The previous worker wrapped the same program without recording its source coordinates.
      vm.evalCode(
        'globalThis.__openclawResult = (async () => {\nawait yield_control();\nthrow new Error("legacy failure");\n})()',
        "openclaw-code-mode:user.js",
        EvalFlags.ASYNC,
      ).dispose();
      vm.executePendingJobs();
      snapshot = vm.snapshot();
    }
    const result = await runQuickJsWire(
      {
        kind: "resume",
        continuation: snapshot,
        config,
        settledRequests: [{ id: "bridge:yield:1", ok: true, json: "null" }],
      },
      10000,
    );
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Error: legacy failure[\s\S]*openclaw-code-mode:user\.js:3:\d+/),
    });
  });

  it.each<[string, string, string, unknown]>([
    [
      "Unicode syntax location",
      "const value = ;",
      "const helper = 'é🦞';",
      expect.stringMatching(/SyntaxError[\s\S]*openclaw-code-mode:user\.js:1:15/),
    ],
    [
      "prelude failure location",
      "return true;",
      'throw new Error("prelude failure");\n',
      "Error: prelude failure",
    ],
  ])("preserves %s", async (_name, source, prelude, error) => {
    expect(await run({ ...input(source), prelude })).toMatchObject({ status: "failed", error });
  });

  it("transfers snapshots and releases consumed heaps and replies", async () => {
    const workerUrl = await instrumentedWorker(
      "code-mode-snapshot-transfer-",
      `
      import assert from "node:assert/strict";
      import { setImmediate } from "node:timers/promises";
      import { setFlagsFromString } from "node:v8";
      import { runInNewContext } from "node:vm";
      import { parentPort } from "node:worker_threads";
      // Bun needs its own synchronous collector; Node exposes V8's collector.
      let gc = () => globalThis.Bun.gc(true);
      if (typeof globalThis.Bun?.gc !== "function") {
        setFlagsFromString("--expose-gc");
        gc = runInNewContext("gc");
      }
      let consumed;
      let settlements = [];
      const on = parentPort.on;
      // Observe the production listener without starting delivery before it is installed.
      parentPort.on = function (event, listener) {
        if (event !== "message") {
          return on.call(this, event, listener);
        }
        parentPort.on = on;
        return on.call(this, event, function (message) {
          if (message.input.kind === "resume") {
            settlements = message.input.settledRequests.map((reply) => new WeakRef(reply));
          }
          return listener.call(this, message);
        });
      };
      const restore = QuickJS.restore;
      QuickJS.restore = async (snapshot, options) => {
        consumed = {
          memory: new WeakRef(snapshot.memory.buffer),
          control: new WeakRef(new ArrayBuffer(1)),
        };
        const vm = await restore(snapshot, options);
        // End the WeakRef creation job before production resumes and releases its input.
        await setImmediate();
        return vm;
      };
      const executePendingJobs = QuickJS.prototype.executePendingJobs;
      QuickJS.prototype.executePendingJobs = function (...args) {
        if (consumed) {
          gc();
          assert.equal(consumed.control.deref(), undefined, "unowned buffer must collect");
          assert.equal(consumed.memory.deref()?.byteLength ?? 0, 0,
            "resumed VM retained its consumed snapshot");
          assert.ok(settlements.every((reference) => reference.deref() === undefined),
            "resumed VM retained delivered settlement values");
          consumed = undefined;
        }
        return executePendingJobs.apply(this, args);
      };
      const serialize = QuickJS.serializeSnapshot;
      QuickJS.serializeSnapshot = (snapshot) => {
        assert.equal(snapshot.memory.byteLength, 0, "snapshot heap serialization copies memory");
        return serialize(snapshot);
      };
      QuickJS.deserializeSnapshot = () => { throw new Error("snapshot heap deserialization copies memory"); };
      const postMessage = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = (message, transferList) => {
        assert.ok(message.value?.status !== "waiting" ||
          transferList?.includes(message.value.continuation.memory.buffer),
          "snapshot heap must transfer to the host");
        postMessage(message, transferList);
      };
      `,
    );
    let result = await runCodeModeWorker(
      input(`const bytes = new Uint8Array(1024 * 1024);
          bytes[0] = 7;
          const sibling = new Promise(resolve => setTimeout(() => {
            bytes[bytes.length - 1] += 2;
            resolve("sibling");
          }, 1));
          await yield_control();
          bytes[bytes.length - 1] = bytes[0];
          await yield_control();
          const siblingValue = await sibling;
          return [bytes.length, bytes[0], bytes[bytes.length - 1], siblingValue];`),
      10_000,
      workerUrl,
    );
    const sent = vi.spyOn(Worker.prototype, "postMessage");
    onTestFinished(() => sent.mockRestore());
    let siblingId: string | undefined;
    for (let leg = 0; leg < 2; leg++) {
      const parked = parkedResult(result);

      const siblingRequests = parked.pendingRequests.filter(({ method }) => method === "sleep");
      expect(siblingRequests).toHaveLength(1);
      if (leg === 0) {
        siblingId = siblingRequests[0]?.id;
      } else {
        expect(siblingRequests[0]?.id).toBe(siblingId);
      }
      const pendingRequests = leg === 0 ? siblingRequests : [];
      result = await runCodeModeWorker(restore(parked, pendingRequests), 10_000, workerUrl);
      const resumed = sent.mock.calls.findLast(([message]) => message.input?.kind === "resume");
      expect(resumed?.[0].input.continuation.memory.buffer.byteLength).toBe(0);
    }
    expectCompleted(result, { kind: "complete", json: '[1048576,7,9,"sibling"]' });
  });

  it("isolates guest globals, bridge failures, and cancellations across warm executions", async () => {
    const limits = createQuickJsTestConfig({ maxPendingToolCalls: 1 });
    const execute = (source: string) => run(input(source, limits));

    expect(
      await execute(
        "globalThis.previousRun = true; for (let i = 0; i < 130; i++) setTimeout(() => {}, 1);",
      ),
    ).toMatchObject({ status: "failed", code: "invalid_input" });
    expect(
      await execute(
        'const timer = setTimeout(() => {}, 1); clearTimeout(timer); await yield_control("pause");',
      ),
    ).toMatchObject({
      status: "waiting",
      canceledRequestIds: ["bridge:sleep:1"],
    });
    expect(await execute('await yield_control("next session");')).toMatchObject({
      status: "waiting",
      canceledRequestIds: [],
      pendingRequests: [{ id: "bridge:yield:1", method: "yield" }],
    });
    expectCompleted(await execute("return typeof globalThis.previousRun;"), {
      kind: "complete",
      json: '"undefined"',
    });
  });

  it.each(["exec", "resume"] as const)(
    "bounds recursive guest execution after %s VM creation",
    async (kind) => {
      const recursion = "function recurse() { return recurse(); } return recurse();";
      const result = await run(await executionInput(recursion, kind));
      expectFailed(result, "internal_error", {
        error: expect.stringContaining("RangeError: Maximum call stack size exceeded"),
        failurePhase: "guest",
      });
      assert(result.status === "failed");
      expect(result.error).not.toContain("memory access out of bounds");
    },
  );

  it.each(
    (["exec", "resume"] as const).flatMap((kind) =>
      [1, -1].map((clockDirection) => ({ kind, clockDirection })),
    ),
  )(
    "keeps $kind guest timeouts independent of a $clockDirection clock jump",
    async ({ kind, clockDirection }) => {
      const limits = createQuickJsTestConfig({ timeoutMs: clockDirection > 0 ? 1_000 : 250 });
      const source =
        clockDirection > 0
          ? "let total = 0; for (let index = 0; index < 100_000; index++) total += index; return total;"
          : "while (true) {}";
      const task = await executionInput(source, kind, limits);
      // Shift the real worker's clock only after its VM deadline starts.
      const workerUrl = await instrumentedWorker(
        "code-mode-worker-clock-",
        `
        const realNow = Date.now;
        let shifted = false;
        const original = QuickJS[${JSON.stringify(kind === "exec" ? "create" : "restore")}];
        QuickJS[${JSON.stringify(kind === "exec" ? "create" : "restore")}] = function (...args) {
            const optionsIndex = ${kind === "exec" ? 0 : 1};
            const options = args[optionsIndex];
            const interrupt = options.interruptHandler;
            args[optionsIndex] = { ...options, interruptHandler: () => {
              if (!shifted) {
                shifted = true;
                Date.now = () => realNow() + ${clockDirection * 60_000};
              }
              return interrupt();
            } };
            return original.apply(this, args);
        };
      `,
      );
      const result = await runCodeModeWorker(task, 5_000, workerUrl);
      expect(result, JSON.stringify(result)).toMatchObject(
        clockDirection > 0
          ? { status: "completed", value: { kind: "complete", json: "4999950000" } }
          : { status: "failed", code: "timeout", failurePhase: "guest" },
      );
    },
  );

  it("honors an already-aborted execution before starting a worker", async () => {
    const result = await runCodeModeWorker(
      input("return true;"),
      10_000,
      undefined,
      AbortSignal.abort(),
    );

    expectFailed(result, "aborted", {
      error: "code mode execution aborted",
      output: EMPTY_CODE_MODE_OUTPUT,
    });
  });

  it("enforces the exact encoded snapshot byte limit", async () => {
    const execute = (maxSnapshotBytes = config.maxSnapshotBytes) =>
      runQuickJsWire(
        input('const value = "x".repeat(100000); await yield_control("pause"); return value;', {
          ...config,
          maxSnapshotBytes,
        }),
        5_000,
      );
    const probe = await execute();
    assert(probe.status === "waiting", "expected a suspended guest");
    const encodedBytes = QuickJS.serializeSnapshot(probe.continuation).byteLength;

    expect(await execute(encodedBytes)).toMatchObject({ status: "waiting" });
    expectFailed(await execute(encodedBytes - 1), "snapshot_limit_exceeded", {
      error: "code mode snapshot limit exceeded",
    });
  });
  it("classifies missing worker runtime as unavailable", async () => {
    const result = await runCodeModeWorker(
      input("return 1;"),
      500,
      new URL("./missing-code-mode.worker.js", import.meta.url),
    );
    expectFailed(result, "runtime_unavailable");
  });
});

describe("Code Mode live VM", () => {
  it.each(["task", "sequence"] as const)(
    "rejects stale worker %s messages before dispatching another host call",
    async (stale) => {
      const source = `import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (message) => {
        if (message.responseId === undefined) {
          parentPort.postMessage({ status: 'request', taskId: message.taskId, id: 1, value: null });
        } else {
          parentPort.postMessage({ status: 'consumed', taskId: message.taskId, id: 1 });
          parentPort.postMessage({ status: 'request', taskId: message.taskId + ${stale === "task" ? 1 : 0}, id: ${stale === "task" ? 2 : 1}, value: null });
        }
      });`;
      const workers = pool(1, new URL("data:text/javascript," + encodeURIComponent(source)));
      const consumed = vi.fn();
      const onRequest = vi.fn(async () => response({ kind: "checkpoint" }, consumed));
      await expect(workers.run({}, { timeoutMs: 2000, onRequest })).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(consumed).toHaveBeenCalledTimes(1);
    },
  );

  it("checkpoints a small VM and restores it with consumed input receipts", async () => {
    const checkpoint = { onBoundary: async () => ({ kind: "checkpoint" as const }) };
    const parked = parkedResult(
      await run(input(`const value = 41; ${sleep} return value + 1;`), checkpoint, 15_000),
    );
    const consumed = vi.fn();
    const result = await run(restore(parked), { ...checkpoint, onInputConsumed: consumed }, 15_000);
    expectCompleted(result, { json: "42" });
    expect(consumed).toHaveBeenCalledTimes(1);
    await parked.continuation.dispose();
    expect(
      await parked.continuation.resume(
        { kind: "resume", config, settledRequests: [] },
        { timeoutMs: 15_000 },
      ),
    ).toMatchObject({ status: "failed", code: "runtime_unavailable" });
  });

  it("keeps outputs and closures through many inline boundaries without leaking into the next cell", async () => {
    const deadline = performance.now() + config.timeoutMs;
    const output: unknown[] = [];
    const receipts = vi.fn();
    let boundaries = 0;
    const result = await run(
      input(
        `globalThis.privateCell = 73; const bytes = new Uint8Array(12 * 1024 * 1024); for (let i = 0; i < 8; i++) { text(i); ${sleep} bytes[i] = i; } return bytes[7];`,
      ),
      {
        onBoundary: async (value) => {
          boundaries++;
          output.push(...completeOutput(value.output));
          return { ...resume(value, deadline), onConsumed: receipts };
        },
      },
      15_000,
    );
    output.push(...completeOutput(result.output));
    expectCompleted(result, { json: "7" });
    expect(boundaries).toBe(8);
    expect(receipts).toHaveBeenCalledTimes(8);
    expect(output).toEqual(
      Array.from({ length: 8 }, (_, i) => ({ type: "text", text: String(i) })),
    );
    expectCompleted(await run(input("return typeof privateCell;"), undefined, 15_000), {
      json: '"undefined"',
    });
  });

  it("checkpoints a slow host waiter under contention so queued cells can run within the same capacity", async () => {
    const workers = pool();
    const entered = Promise.withResolvers<void>();
    const releaseHost = Promise.withResolvers<void>();
    const events: string[] = [];
    const hostCompleted = releaseHost.promise.then(() => {
      events.push("host completed");
    });
    const waiting = runCell(workers, `${sleep} return 1;`, async (value, { yieldSignal }) => {
      entered.resolve();
      return Promise.race([
        waitForAbort(yieldSignal).then(() => response({ kind: "checkpoint" })),
        hostCompleted.then(() => response(resume(boundary(value), performance.now() + 1000))),
      ]);
    }).then((result) => {
      events.push(`waiter ${result.status}`);
      return result;
    });
    await entered.promise;
    const quick = runCell(workers, "return 2;", undefined, 2000).then((result) => {
      events.push(`queued ${result.status}`);
      return result;
    });
    try {
      const [parked, completed] = await Promise.all([waiting, quick]);
      expect(events).toEqual(["waiter waiting", "queued completed"]);
      expect(parked).toMatchObject({
        status: "waiting",
        pendingRequests: [{ method: "sleep" }],
        settlementMode: { kind: "awaiting" },
      });
      expectCompleted(completed, { json: "2" });
    } finally {
      releaseHost.resolve();
      await hostCompleted;
      await workers.close();
      await Promise.allSettled([waiting, quick]);
    }
  });

  it("pressures a newly waiting worker when an earlier pressured waiter has not yielded", async () => {
    const workers = pool(2);
    const firstEntered = Promise.withResolvers<void>();
    const firstPressured = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let secondBoundaries = 0;
    const first = runCell(workers, `${sleep} return 1;`, async (_value, { yieldSignal }) => {
      yieldSignal.addEventListener("abort", () => firstPressured.resolve(), { once: true });
      firstEntered.resolve();
      await releaseFirst.promise;
      return response({ kind: "checkpoint" });
    });
    await firstEntered.promise;
    const second = runCell(
      workers,
      `${sleep} ${sleep} return 2;`,
      async (value, { signal, yieldSignal }) => {
        if (++secondBoundaries === 1) {
          secondEntered.resolve();
          await firstPressured.promise;
          return response(resume(boundary(value), performance.now() + config.timeoutMs));
        }
        await waitForAbort(yieldSignal, signal);
        return response({ kind: "checkpoint" });
      },
    );
    // Finish cold startup before queueing the work that pressures existing waiters.
    await secondEntered.promise;
    const quick = runCell(workers, "return 3;", undefined, 2000);
    const outcomes = Promise.allSettled([first, second, quick]);
    try {
      await firstPressured.promise;
      expectCompleted(await quick, { json: "3" });
      expect(await second).toMatchObject({ status: "waiting" });
      expect(secondBoundaries).toBe(2);
    } finally {
      releaseFirst.resolve();
      await workers.close();
      await outcomes;
    }
  });
});
