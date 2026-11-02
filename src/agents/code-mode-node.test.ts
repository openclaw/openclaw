import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BroadcastChannel, getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as runtimeProcess from "../infra/runtime-process-url.js";
import { sampleTrackedWorkerMemory } from "../infra/worker-cpu.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { writeSealedRuntimeProcessFixture } from "../test-utils/sealed-runtime-process-fixture.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeExecutorResumeInput,
  CodeModeExecutorRunOptions,
  CodeModeExecutorStartInput,
  CodeModeWorkerResult,
} from "./code-mode-executor-types.js";
import { nodeCodeModeExecutor } from "./code-mode-node.js";

const config = {
  timeoutMs: 5_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64 * 1024,
  maxPendingToolCalls: 16,
  maxSnapshotBytes: 10 * 1024 * 1024,
};
const continuations = new Set<CodeModeExecutorContinuation>();
let host: LegacyPluginSdkResourceHost;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
beforeEach(() => {
  host = new LegacyPluginSdkResourceHost();
  scheduler = createTestGatewayScheduler();
  host.bindScheduler(scheduler);
});
afterEach(async () => {
  try {
    await Promise.all([...continuations].map((continuation) => continuation.dispose()));
  } finally {
    continuations.clear();
    try {
      await host.close();
    } finally {
      await scheduler.stop();
    }
  }
});

function input(
  source: string,
  overrides: Partial<CodeModeExecutorStartInput> = {},
): CodeModeExecutorStartInput {
  return { kind: "exec", source, config, catalog: [], namespaces: [], ...overrides };
}

function execute(
  source: string,
  overrides: Partial<CodeModeExecutorStartInput> = {},
  options: Partial<CodeModeExecutorRunOptions> = {},
) {
  return host.run(() =>
    nodeCodeModeExecutor.execute(input(source, overrides), { timeoutMs: 7_000, ...options }),
  );
}

function waiting(result: CodeModeWorkerResult) {
  assert(result.status === "waiting", JSON.stringify(result));
  continuations.add(result.continuation);
  return result;
}

function resume(
  result: ReturnType<typeof waiting>,
  overrides: Partial<CodeModeExecutorResumeInput> = {},
) {
  return result.continuation.resume(
    {
      kind: "resume",
      config,
      settledRequests: result.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
      ...overrides,
    },
    { timeoutMs: 7_000 },
  );
}

const workerStarts = () =>
  sampleTrackedWorkerMemory().workerLifecycle.find(
    ({ script }) => script === "code-mode-node.worker.js",
  )?.started ?? 0;

function expectComplete(result: CodeModeWorkerResult, json: string) {
  expect(result).toMatchObject({ status: "completed", value: { kind: "complete", json } });
}

const textOutput = (...texts: string[]) => ({
  count: texts.length,
  source: { kind: "complete", json: JSON.stringify(texts.map((text) => ({ type: "text", text }))) },
});
const guestTimeout = {
  status: "failed",
  code: "timeout",
  error: "code mode timeout exceeded",
  failurePhase: "guest",
};

async function runNodeProbe(
  body: string,
  workerUrl = runtimeProcess.resolveRuntimeProcessEntrypointUrl("codeModeNode"),
): Promise<unknown> {
  return withTempDir("code-mode-probe-", async (directory) => {
    const bootstrap = await writeSealedRuntimeProcessFixture(directory, "worker", {
      codeModeNode: workerUrl,
    });
    const probe = `
      import { nodeCodeModeExecutor } from ${JSON.stringify(new URL("./code-mode-node.ts", import.meta.url).href)};
      import { registerSealedRuntimeProcessEntrypoints } from ${JSON.stringify(new URL("../infra/runtime-process-url.ts", import.meta.url).href)};
      import { LegacyPluginSdkResourceHost } from ${JSON.stringify(new URL("../plugins/legacy-sdk-resource-host.ts", import.meta.url).href)};
      import { createTestGatewayScheduler } from ${JSON.stringify(new URL("../test-utils/gateway-scheduler-clock.ts", import.meta.url).href)};
      registerSealedRuntimeProcessEntrypoints("worker", ${JSON.stringify(bootstrap)});
      const host = new LegacyPluginSdkResourceHost();
      const scheduler = createTestGatewayScheduler();
      host.bindScheduler(scheduler);
      try {
        const config = ${JSON.stringify(config)};
        const run = (source, overrides = {}, options = {}) => host.run(() => nodeCodeModeExecutor.execute(
          { kind: "exec", config, catalog: [], namespaces: [], source, ...overrides },
          { timeoutMs: 7000, ...options },
        ));
        const onBoundary = async (boundary, context) => ({
          kind: "continue", timeoutMs: Math.min(1000, context.maxTimeoutMs), pendingRequests: [],
          settledRequests: boundary.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
        });
        ${body}
      } finally {
        await host.close();
        await scheduler.stop();
      }
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
        "--input-type=module",
        "-e",
        probe,
      ],
      { env: { ...process.env, NODE_OPTIONS: "" }, timeout: 25_000 },
    );
    return JSON.parse(stdout);
  });
}

it.each([
  ["await yield_control()", "host", "internal_error", 1],
  ['throw new Error("invalid code mode continuation timeout")', "guest", "internal_error", 0],
  ["await new Promise(() => {})", "input", "invalid_input", 0],
] as const)("preserves failure provenance for %s", async (source, phase, code, calls) => {
  const onFailure = vi.fn();
  const onBoundary = vi.fn(async () => ({
    kind: "continue" as const,
    timeoutMs: Number.NaN,
    pendingRequests: [],
    settledRequests: [],
  }));
  const result = await execute(source, {}, { inlineHost: { onBoundary, onFailure } });
  expect(result).toMatchObject({ status: "failed", code, failurePhase: phase });
  expect(onFailure).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    phase,
    expect.stringMatching(/^code-mode-node:/),
  );
  expect(onBoundary).toHaveBeenCalledTimes(calls);
});

it("reuses healthy workers after rejected cells without retaining guest state", async () => {
  const before = workerStarts();
  for (const source of [
    "return (",
    'require("node:fs")',
    'globalThis.failedCell = true; throw new Error("guest failure");',
    'globalThis.failedCell = true; Promise.reject(new Error("unhandled failure")); return 1;',
  ]) {
    expect(await execute(source)).toMatchObject({ status: "failed" });
    expectComplete(await execute("return typeof failedCell;"), '"undefined"');
  }
  const parked = waiting(await execute("globalThis.failedCell = true; await yield_control();"));
  expect(
    await resume(parked, {
      settledRequests: parked.pendingRequests.map(({ id }) => ({
        id,
        ok: false,
        json: '"bridge failure"',
      })),
    }),
  ).toMatchObject({ status: "failed" });
  expectComplete(await execute("return typeof failedCell;"), '"undefined"');
  expect(workerStarts() - before).toBe(1);
});

it("contains dynamic imports and late guest rejections in the owning cell", async () => {
  const sources = [
    "await import('node:fs')",
    `await eval("import('node:fs')")`,
    `await new Function("return import('node:fs')")()`,
    `await (() => {}).constructor("return import('node:fs')")()`,
    `Promise.resolve().then(() => eval("import('node:fs')")); return 1`,
    `setTimeout(() => eval("import('node:fs')"), 0); return 1`,
  ];
  const observed = await runNodeProbe(`
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(String(error)));
    const sibling = await run('await yield_control(); return 42');
    const failures = [];
    for (const source of ${JSON.stringify(sources)}) {
      failures.push(await run(source, {}, { inlineHost: { onBoundary } }));
    }
    const caught = await run(${JSON.stringify(`try { await eval("import('node:fs')"); } catch (error) { return error.message; }`)});
    const late = await run('Promise.resolve().then(() => { throw new Error("late failure"); }); return 1');
    const resumed = await sibling.continuation.resume({ kind: 'resume', config,
      settledRequests: sibling.pendingRequests.map(({ id }) => ({ id, ok: true, json: 'null' })),
    }, { timeoutMs: 7000 });
    const recovered = await run('return 7');
    console.log(JSON.stringify({ failures, caught, late, resumed, recovered, unhandled }));
  `);
  expect(observed).toMatchObject({
    failures: sources.map(() => ({
      status: "failed",
      error: expect.stringContaining("code mode module access is disabled"),
    })),
    caught: {
      status: "completed",
      value: { json: expect.stringContaining("code mode module access is disabled") },
    },
    late: { status: "failed", error: expect.stringContaining("late failure") },
    resumed: { status: "completed", value: { json: "42" } },
    recovered: { status: "completed", value: { json: "7" } },
    unhandled: [],
  });
});

it("reports heap exhaustion, recovers, and bounds captured output below the heap limit", async () => {
  // Vitest runs inside a Worker whose inherited heap flags can override resourceLimits.
  // A standalone process exercises native OOM without changing the test runner's V8 flags.
  const observed = await runNodeProbe(`
      let boundaries = 0;
      let failure;
        const result = await run(
          'await yield_control(); text("before allocation"); const data = []; for (let i = 0; i < 2_000_000; i++) data.push({ i, value: String(i) }); return data.length;',
          {}, { inlineHost: {
          onBoundary: (...args) => { boundaries++; return onBoundary(...args); },
          onFailure: (error, phase, workerId) => {
            failure = { code: error.cause?.code, phase, workerId };
          },
        } });
        const recovered = await run("return 42");
        const boundedOutput = await run('for (let i = 0; i < 20000; i++) json({ i, value: "x".repeat(4096) }); return 42;');
        console.log(JSON.stringify({ result, recovered, boundedOutput, boundaries, failure }));
    `);
  expect(observed).toMatchObject({
    boundaries: 1,
    result: {
      status: "failed",
      code: "runtime_unavailable",
      error: expect.stringContaining("exhausted its 64 MiB JavaScript heap"),
      output: textOutput("before allocation"),
    },
    failure: {
      code: "ERR_WORKER_OUT_OF_MEMORY",
      phase: "host",
      workerId: expect.stringMatching(/^code-mode-node:/),
    },
    recovered: { status: "completed", value: { json: "42" } },
    boundedOutput: {
      status: "completed",
      value: { json: "42" },
      output: { count: 20000, source: { kind: "prefix" } },
    },
  });
  expect(observed).toMatchObject({
    result: { error: expect.stringContaining("Inspect any completed actions before retrying") },
  });
});
// Bun lacks V8's GCProfiler and --expose_gc; native OOM is covered above.
it.skipIf(Boolean(process.versions.bun))(
  "stops sustained near-limit major collections even with zero reported duration and recovers",
  async () => {
    // Keep retained allocations live and measure occupancy after native collections.
    const pressureSource = `
      const data = globalThis.retained = [];
      collectGarbage();
      while (heapStatistics().used_heap_size < heapStatistics().heap_size_limit * 0.86) {
        for (let i = 0; i < 4; i++) data.push(new Array(131072).fill(1));
        collectGarbage();
        await yield_control();
      }
      for (;;) {
        collectGarbage();
        await yield_control();
      }
    `;
    const observed = await runNodeProbe(
      `
        const pressureConfig = { ...config, timeoutMs: 10000, memoryLimitBytes: 128 * 1024 * 1024 };
        const lowPressure = await run(
          'const until = Date.now() + 1100; while (Date.now() < until) { collectGarbage(); await yield_control(); } return 1;',
          { config: pressureConfig }, { inlineHost: { onBoundary } },
        );
        const pressureStarted = performance.now();
        const pressure = await run(${JSON.stringify(pressureSource)},
          { config: pressureConfig }, { timeoutMs: 10000, inlineHost: { onBoundary } });
        const pressureMs = performance.now() - pressureStarted;
        const afterPressure = await run("return 7");
        console.log(JSON.stringify({ pressure, pressureEndedQuickly: pressureMs < 5000, afterPressure, lowPressure }));
      `,
      new URL("./code-mode-node.watchdog.test-support.ts", import.meta.url),
    );
    expect(observed).toMatchObject({
      lowPressure: { status: "completed", value: { json: "1" } },
      pressureEndedQuickly: true,
      pressure: {
        status: "failed",
        code: "runtime_unavailable",
        error: expect.stringContaining(
          "sustained garbage collection near its JavaScript heap limit",
        ),
      },
      afterPressure: { status: "completed", value: { json: "7" } },
    });
  },
);

it.each([
  ["alternating limits", 20, 1, [64, 96], 2],
  ["concurrent continuations", 2, 8, [64, 96], 8],
] as const)(
  "keeps workers warm across %s",
  async (scenario, rounds, concurrency, limits, maxWorkers) => {
    const parked = scenario === "concurrent continuations";
    channel("openclaw.memory.critical").publish({});
    const before = workerStarts();
    for (let round = 0; round < rounds; round++) {
      const results = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          execute(parked ? "await yield_control(); return 1;" : "return 1;", {
            config: {
              ...config,
              memoryLimitBytes: limits[(round * concurrency + i) % 2]! * 1024 * 1024,
            },
          }),
        ),
      );
      await Promise.all(
        results.map(async (outcome) => {
          if (!parked) {
            expect(outcome).toMatchObject({ status: "completed" });
            return;
          }
          const result = waiting(outcome);
          // Pressure must spare live continuations even while their task is idle.
          channel("openclaw.memory.critical").publish({});
          expect(await resume(result)).toMatchObject({
            status: "completed",
            value: { json: "1" },
          });
        }),
      );
    }
    expect(workerStarts() - before).toBeLessThanOrEqual(maxWorkers);
  },
);

it("retains lexical state through one-shot waits and disposes only its owned continuation", async () => {
  let result = waiting(
    await execute(
      "const state = { value: 1 }; await yield_control(); state.value += 2; await yield_control(); return state;",
    ),
  );
  const first = result.continuation;
  expect(first.retainedBytes).toBe(config.memoryLimitBytes);
  result = waiting(await resume(result, { pendingRequests: [] }));
  await first.dispose();
  expect(
    await first.resume({ kind: "resume", config, settledRequests: [] }, { timeoutMs: 7_000 }),
  ).toMatchObject({ status: "failed", code: "runtime_unavailable" });
  expectComplete(await resume(result, { pendingRequests: [] }), '{"value":3}');
});

it("interrupts guest execution after an async yield and recovers the worker", async () => {
  const started = performance.now();
  expect(
    await execute(
      'text("before"); json({ n: 1 }); console.log("diagnostic"); await null; while (true) {}',
      { executionTimeoutMs: 30 },
    ),
  ).toMatchObject(guestTimeout);
  // Includes cold Worker startup, but must not spend the 5 s wall budget.
  expect(performance.now() - started).toBeLessThan(2_000);
  expectComplete(await execute("return 42"), "42");
});

it("preserves published output when interrupting inherited JSON hooks", async ({ signal }) => {
  const source =
    'Object.prototype.toJSON = () => { throw new Error("inherited hook"); }; text("safe"); while (true) {}';
  const worker = new URL(
    "../../test/helpers/code-mode-node.timeout.test-support.ts",
    import.meta.url,
  );
  const notifications = new BroadcastChannel(randomUUID());
  const environmentKey = "openclaw.codeModeTimeoutOutputTest";
  const previousEnvironment = getEnvironmentData(environmentKey);
  setEnvironmentData(environmentKey, notifications.name);
  const published = createDeferred();
  const consumed = createDeferred();
  const count = 4;
  notifications.addEventListener("message", ({ data }) => {
    if (data === count) {
      published.resolve();
    }
  });
  const resolveWorker = runtimeProcess.resolveRuntimeProcessEntrypointUrl;
  const resolver = vi
    .spyOn(runtimeProcess, "resolveRuntimeProcessEntrypointUrl")
    .mockImplementation((name) => (name === "codeModeNode" ? worker : resolveWorker(name)));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const operation = execute(
      'text("before"); json({ n: 1 }); console.log("diagnostic"); ' + source,
      { executionTimeoutMs: 30 },
      {
        timeoutMs: 7_000,
        signal,
        inlineHost: {
          onInputConsumed: () => consumed.resolve(),
          onBoundary: async () => {
            throw new Error("The infinite loop must not flush its output at a boundary");
          },
        },
      },
    );
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all([published.promise, consumed.promise]),
        operation,
        "Execution ended before output publication",
      ),
      signal,
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(await withinTest(operation, signal)).toMatchObject({
      ...guestTimeout,
      output: {
        count,
        source: {
          kind: "complete",
          json: '[{"type":"text","text":"before"},{"type":"json","value":{"n":1}},{"type":"text","text":"diagnostic"},{"type":"text","text":"safe"}]',
        },
      },
    });
  } finally {
    vi.useRealTimers();
    resolver.mockRestore();
    setEnvironmentData(environmentKey, previousEnvironment);
    notifications.close();
  }
  expectComplete(await execute("return 42"), "42");
});

it("creates fresh globals for a reused worker and preserves pure encoding APIs", async () => {
  expectComplete(
    await execute(
      `const decoded = new TextDecoder().decode(new TextEncoder().encode('hello 🦞'));
        globalThis.leftBehind = 1;
        TextEncoder.prototype.leftBehind = 1;
        const encoderParent = Object.getPrototypeOf(TextEncoder.prototype);
        const decoderParent = Object.getPrototypeOf(TextDecoder.prototype);
        encoderParent.leftBehind = 1;
        decoderParent.leftBehind = 1;
        encoderParent.encode = () => new Uint8Array([0]);
        decoderParent.decode = () => 'poisoned';
        return decoded;`,
    ),
    '"hello 🦞"',
  );
  expectComplete(
    await execute(
      `return [
          typeof leftBehind,
          typeof TextEncoder.prototype.leftBehind,
          typeof TextDecoder.prototype.leftBehind,
          typeof process, typeof require, typeof fetch,
          Array.from(new TextEncoder().encode('🦞')),
          new TextDecoder().decode(new Uint8Array([240, 159, 166, 158])),
        ];`,
    ),
    '["undefined","undefined","undefined","undefined","undefined","undefined",[240,159,166,158],"🦞"]',
  );
});

it.each(["resume", "inline"] as const)(
  "does not replay delivered output when %s times out",
  async (mode) => {
    const start = input(
      'text("before"); await yield_control(); text("after"); await yield_control(); while (true) {}',
    );
    const reply = (id: string) => ({ id, ok: true, json: "null" });
    const delivered: unknown[] = [];
    const onFailure = vi.fn();
    let result = await nodeCodeModeExecutor.execute(start, {
      timeoutMs: 7_000,
      ...(mode === "inline"
        ? {
            inlineHost: {
              onFailure,
              onBoundary: async (boundary, context) => {
                delivered.push(boundary.output);
                return {
                  kind: "continue",
                  timeoutMs: delivered.length === 1 ? context.maxTimeoutMs : 30,
                  pendingRequests: [],
                  settledRequests: boundary.pendingRequests.map(({ id }) => reply(id)),
                };
              },
            },
          }
        : {}),
    });
    if (mode === "resume") {
      for (const timeoutMs of [config.timeoutMs, 30]) {
        const parked = waiting(result);
        delivered.push(parked.output);
        result = await resume(parked, { config: { ...config, timeoutMs } });
      }
    }
    expect(delivered).toEqual([textOutput("before"), textOutput("after")]);
    expect(result).toMatchObject({
      status: "failed",
      code: "timeout",
      failurePhase: "guest",
      output: textOutput(),
    });
    if (mode === "inline") {
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "timeout" }),
        "guest",
        expect.stringMatching(/^code-mode-node:/),
      );
    }
  },
);

it("joins worker cancellation while the host owns a pending bridge exchange", async () => {
  const controller = new AbortController();
  const boundary = createDeferred();
  const result = nodeCodeModeExecutor.execute(input("await yield_control(); return 1;"), {
    timeoutMs: 7_000,
    signal: controller.signal,
    inlineHost: {
      onBoundary: async (_value, { signal }) => {
        boundary.resolve();
        await once(signal, "abort");
        throw new Error("Host bridge aborted", { cause: signal.reason });
      },
    },
  });
  await boundary.promise;
  controller.abort();
  expect(await result).toMatchObject({ status: "failed", code: "aborted" });
  expectComplete(await execute("return 7"), "7");
});
