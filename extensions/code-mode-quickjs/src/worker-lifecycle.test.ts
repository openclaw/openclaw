import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  CODE_MODE_CONTROLLER_SOURCE,
  EMPTY_CODE_MODE_OUTPUT,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { EvalFlags, QuickJS, type Snapshot } from "quickjs-wasi";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createQuickJsTestConfig,
  runQuickJsExecutor as runCodeModeWorker,
  runQuickJsWire,
} from "./executor.test-support.js";
import { quickJsWorkerTestEntrypoint } from "./worker-entrypoint.test-support.js";

const productionWorkerUrl = resolveRuntimeWorkerUrl(quickJsWorkerTestEntrypoint);
const fixtureExtension = productionWorkerUrl.pathname.endsWith(".ts") ? "ts" : "mjs";
const config = createQuickJsTestConfig();

function input(source: string, limits = config) {
  return { kind: "exec" as const, source, config: limits, catalog: [], namespaces: [] };
}

async function executionInput(source: string, kind: "exec" | "resume", limits = config) {
  if (kind === "exec") {
    return input(source, limits);
  }
  const suspended = await runCodeModeWorker(
    input(`await yield_control(); ${source}`, limits),
    10_000,
  );
  expect(suspended.status).toBe("waiting");
  if (suspended.status !== "waiting") {
    throw new Error("expected a suspended guest before execution");
  }
  return {
    kind,
    config: limits,
    continuation: suspended.continuation,
    settledRequests: suspended.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
  };
}

async function instrumentedWorker(prefix: string, source: string) {
  const dir = useAutoCleanupTempDirTracker(onTestFinished).make(prefix);
  const workerPath = path.join(dir, `worker.${fixtureExtension}`);
  const quickJsUrl = pathToFileURL(createRequire(import.meta.url).resolve("quickjs-wasi"));
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

// Restore the WeakRef retention probe when Bun's node:v8 exposure can provide a synchronous
// worker-local gc without stalling the instrumented QuickJS resume path.
const v8GcIt = process.versions.bun ? it.skip : it;

describe("Code Mode worker lifecycle", () => {
  it("preserves legacy snapshot errors without source-location metadata", async () => {
    const wasm = await WebAssembly.compile(
      await readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")),
    );
    const vm = await QuickJS.create({ wasm, memoryLimit: config.memoryLimitBytes });
    let snapshot: Snapshot;
    try {
      vm.newFunction("__openclawHostRequest", (_method, _args, id) =>
        vm.newString(id.toString()),
      ).consume((handle) => vm.global.setProp("__openclawHostRequest", handle));
      vm.newFunction("__openclawHostCancelRequest", () => vm.undefined).consume((handle) =>
        vm.global.setProp("__openclawHostCancelRequest", handle),
      );
      for (const [name, value] of Object.entries({
        __openclawCatalog: [],
        __openclawNamespaces: [],
        __openclawApiFiles: [],
        __openclawSwarmEnabled: false,
        __openclawMaxPendingToolCalls: config.maxPendingToolCalls,
      })) {
        vm.hostToHandle(value).consume((handle) => vm.global.setProp(name, handle));
      }
      vm.evalCode(CODE_MODE_CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
      // The previous worker wrapped the same program without recording its source coordinates.
      vm.evalCode(
        'globalThis.__openclawResult = (async () => {\nawait yield_control();\nthrow new Error("legacy failure");\n})()',
        "openclaw-code-mode:user.js",
        EvalFlags.ASYNC,
      ).dispose();
      vm.executePendingJobs();
      snapshot = vm.snapshot();
    } finally {
      vm.dispose();
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
      error: expect.stringContaining("Error: legacy failure"),
    });
    if (result.status !== "failed") {
      throw new Error("Expected legacy guest failure");
    }
    expect(result.error).toMatch(/openclaw-code-mode:user\.js:3:\d+/);
  });

  it("accounts for a same-line Unicode prelude in syntax locations", async () => {
    const result = await runCodeModeWorker(
      {
        ...input("const value = ;"),
        prelude: "const helper = 'é🦞';",
      },
      10000,
    );
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("SyntaxError"),
    });
    if (result.status !== "failed") {
      throw new Error("Expected guest syntax failure");
    }
    expect(result.error).toContain("openclaw-code-mode:user.js:1:15");
  });

  it("does not attribute a prelude failure to submitted source", async () => {
    const result = await runCodeModeWorker(
      {
        ...input("return true;"),
        prelude: 'throw new Error("prelude failure");\n',
      },
      10000,
    );
    expect(result).toMatchObject({ status: "failed", error: "Error: prelude failure" });
  });

  v8GcIt("transfers snapshot heaps and releases consumed copies across resumes", async () => {
    // The dependency's storage codec copies the whole heap in both directions.
    // Exercise real snapshots and restores while allowing metadata-only accounting.
    const workerUrl = await instrumentedWorker(
      "code-mode-snapshot-transfer-",
      `
      import assert from "node:assert/strict";
      import { setImmediate } from "node:timers/promises";
      import { setFlagsFromString } from "node:v8";
      import { runInNewContext } from "node:vm";
      import { parentPort } from "node:worker_threads";
      setFlagsFromString("--expose-gc");
      const gc = runInNewContext("gc");
      let consumed;
      let settlements = [];
      parentPort.on("message", ({ input }) => {
        if (input.kind === "resume") {
          settlements = input.settledRequests.map((reply) => new WeakRef(reply));
        }
      });
      const restore = QuickJS.restore;
      QuickJS.restore = async (snapshot, options) => {
        consumed = {
          memory: new WeakRef(snapshot.memory.buffer),
          bytes: snapshot.memory.buffer.byteLength,
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
            "resumed VM retained its consumed " + consumed.bytes + " byte snapshot");
          assert.ok(settlements.every((reference) => reference.deref() === undefined),
            "resumed VM retained delivered settlement values");
          consumed = undefined;
        }
        return executePendingJobs.apply(this, args);
      };
      const serialize = QuickJS.serializeSnapshot;
      QuickJS.serializeSnapshot = (snapshot) => {
        if (snapshot.memory.byteLength > 0) throw new Error("snapshot heap serialization copies memory");
        return serialize(snapshot);
      };
      QuickJS.deserializeSnapshot = () => { throw new Error("snapshot heap deserialization copies memory"); };
      const postMessage = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = (message, transferList) => {
        if (message.value?.status === "waiting" &&
            !transferList?.includes(message.value.continuation.memory.buffer)) {
          throw new Error("snapshot heap must transfer to the host");
        }
        postMessage(message, transferList);
      };
      `,
    );
    let result = await runCodeModeWorker(
      {
        kind: "exec",
        source: `const bytes = new Uint8Array(1024 * 1024);
          bytes[0] = 7;
          const sibling = new Promise(resolve => setTimeout(() => {
            bytes[bytes.length - 1] += 2;
            resolve("sibling");
          }, 1));
          await yield_control();
          bytes[bytes.length - 1] = bytes[0];
          await yield_control();
          const siblingValue = await sibling;
          return [bytes.length, bytes[0], bytes[bytes.length - 1], siblingValue];`,
        config,
        catalog: [],
      },
      10_000,
      workerUrl,
    );
    const sent = vi.spyOn(Worker.prototype, "postMessage");
    onTestFinished(() => sent.mockRestore());
    let siblingId: string | undefined;
    for (let leg = 0; leg < 2; leg++) {
      expect(result, result.status === "failed" ? result.error : undefined).toMatchObject({
        status: "waiting",
      });
      if (result.status !== "waiting") {
        throw new Error("expected a suspended guest");
      }

      const siblingRequests = result.pendingRequests.filter(({ method }) => method === "sleep");
      expect(siblingRequests).toHaveLength(1);
      if (leg === 0) {
        siblingId = siblingRequests[0]?.id;
      } else {
        expect(siblingRequests[0]?.id).toBe(siblingId);
      }
      const pendingRequests = leg === 0 ? siblingRequests : [];
      result = await runCodeModeWorker(
        {
          kind: "resume",
          continuation: result.continuation,
          config,
          pendingRequests,
          settledRequests: result.pendingRequests
            .filter((request) => !pendingRequests.includes(request))
            .map(({ id }) => ({ id, ok: true, json: JSON.stringify({ leg }) })),
        },
        10_000,
        workerUrl,
      );
      const resumed = sent.mock.calls.findLast(([message]) => message.input?.kind === "resume");
      expect(resumed?.[0].input.continuation.memory.buffer.byteLength).toBe(0);
    }
    expect(result).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: '[1048576,7,9,"sibling"]' },
    });
  });

  it("isolates guest globals, bridge failures, and cancellations across warm executions", async () => {
    const limits = createQuickJsTestConfig({ maxPendingToolCalls: 1 });
    const execute = (source: string) => runCodeModeWorker(input(source, limits), 10_000);

    expect(
      await execute(
        "globalThis.previousRun = true; for (let i = 0; i < 130; i++) setTimeout(() => {}, 1);",
      ),
    ).toMatchObject({ status: "failed", code: "invalid_input" });
    const cancelled = await execute(
      'const timer = setTimeout(() => {}, 1); clearTimeout(timer); await yield_control("pause");',
    );
    expect(cancelled).toMatchObject({
      status: "waiting",
      canceledRequestIds: ["bridge:sleep:1"],
    });
    expect(await execute('await yield_control("next session");')).toMatchObject({
      status: "waiting",
      canceledRequestIds: [],
      pendingRequests: [{ id: "bridge:yield:1", method: "yield" }],
    });
    expect(await execute("return typeof globalThis.previousRun;")).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: '"undefined"' },
    });
  });

  it.each(["exec", "resume"] as const)(
    "bounds recursive guest execution after %s VM creation",
    async (kind) => {
      const recursion = "function recurse() { return recurse(); } return recurse();";
      const result = await runCodeModeWorker(await executionInput(recursion, kind), 10_000);
      expect(result).toMatchObject({
        status: "failed",
        code: "internal_error",
        error: expect.stringContaining("RangeError: Maximum call stack size exceeded"),
        failurePhase: "guest",
      });
      if (result.status === "failed") {
        expect(result.error).not.toContain("memory access out of bounds");
      }
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
      // Change the clock inside the real worker, after its VM deadline starts.
      // Parent-only clock spies cannot reach this isolated thread.
      const workerUrl = await instrumentedWorker(
        "code-mode-worker-clock-",
        `
        const realNow = Date.now;
        let shifted = false;
        for (const method of ["create", "restore"]) {
          const original = QuickJS[method];
          QuickJS[method] = function (...args) {
            const optionsIndex = method === "create" ? 0 : 1;
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
        }
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
    const controller = new AbortController();
    controller.abort();

    const result = await runCodeModeWorker(
      input("return true;"),
      10_000,
      undefined,
      controller.signal,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
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
    expect(probe.status).toBe("waiting");
    if (probe.status !== "waiting") {
      throw new Error("expected a suspended guest to measure its snapshot");
    }
    const encodedBytes = QuickJS.serializeSnapshot(probe.continuation).byteLength;

    expect(await execute(encodedBytes)).toMatchObject({ status: "waiting" });
    expect(await execute(encodedBytes - 1)).toMatchObject({
      status: "failed",
      code: "snapshot_limit_exceeded",
      error: "code mode snapshot limit exceeded",
    });
  });
  it("classifies missing worker runtime as unavailable", async () => {
    const missingWorkerUrl = new URL("./missing-code-mode.worker.js", import.meta.url);

    const result = await runCodeModeWorker(input("return 1;"), 500, missingWorkerUrl);

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies clean worker exits without a result as unavailable", async () => {
    const exitingWorkerUrl = new URL("data:text/javascript,");

    const result = await runCodeModeWorker(input("return 1;"), 5_000, exitingWorkerUrl);

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      error: expect.stringContaining("worker exited with code 0"),
    });
  });
});
