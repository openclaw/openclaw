import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { BroadcastChannel, getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as runtimeProcess from "../infra/runtime-process-url.js";
import { sampleTrackedWorkerMemory } from "../infra/worker-cpu.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeExecutorStartInput,
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
const timeoutSources = [
  "await null; while (true) {}",
  'Object.prototype.toJSON = () => { throw new Error("inherited hook"); }; text("safe"); while (true) {}',
];
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

function execute(source: string, overrides: Partial<CodeModeExecutorStartInput> = {}) {
  return host.run(() =>
    nodeCodeModeExecutor.execute(
      { kind: "exec", source, config, catalog: [], namespaces: [], ...overrides },
      { timeoutMs: 7_000 },
    ),
  );
}

describe("Node Code Mode executor", () => {
  it.each(["alternating limits", "concurrent continuations"] as const)(
    "keeps workers warm across %s",
    async (scenario) => {
      channel("openclaw.memory.critical").publish({});
      const starts = () =>
        sampleTrackedWorkerMemory().workerLifecycle.find(
          ({ script }) => script === "code-mode-node.worker.js",
        )?.started ?? 0;
      const before = starts();
      if (scenario === "alternating limits") {
        for (let i = 0; i < 20; i++) {
          expect(
            await execute("return 1;", {
              config: { ...config, memoryLimitBytes: (i % 2 ? 96 : 64) * 1024 * 1024 },
            }),
          ).toMatchObject({ status: "completed" });
        }
        expect(starts() - before).toBeLessThanOrEqual(2);
      } else {
        for (let round = 0; round < 2; round++) {
          const results = await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
              execute("await yield_control(); return 1;", {
                config: { ...config, memoryLimitBytes: (i % 2 ? 160 : 128) * 1024 * 1024 },
              }),
            ),
          );
          await Promise.all(
            results.map(async (result) => {
              if (result.status !== "waiting") {
                throw new Error(JSON.stringify(result));
              }
              continuations.add(result.continuation);
              // Pressure must spare live continuations even while their task is idle.
              channel("openclaw.memory.critical").publish({});
              expect(
                await result.continuation.resume(
                  {
                    kind: "resume",
                    config,
                    settledRequests: result.pendingRequests.map(({ id }) => ({
                      id,
                      ok: true,
                      json: "null",
                    })),
                  },
                  { timeoutMs: 7_000 },
                ),
              ).toMatchObject({ status: "completed", value: { json: "1" } });
            }),
          );
        }
        expect(starts() - before).toBeLessThanOrEqual(4);
      }
    },
  );

  it("retains lexical state through one-shot waits and disposes only its owned continuation", async () => {
    let result = await execute(
      "const state = { value: 1 }; await yield_control(); state.value += 2; await yield_control(); return state;",
    );
    expect(result.status).toBe("waiting");
    if (result.status !== "waiting") {
      throw new Error(JSON.stringify(result));
    }
    const first = result.continuation;
    continuations.add(first);
    expect(first.retainedBytes).toBe(config.memoryLimitBytes);
    result = await first.resume(
      {
        kind: "resume",
        config,
        settledRequests: [{ id: result.pendingRequests[0]!.id, ok: true, json: "null" }],
        pendingRequests: [],
      },
      { timeoutMs: 7_000 },
    );
    expect(result.status).toBe("waiting");
    if (result.status !== "waiting") {
      throw new Error(JSON.stringify(result));
    }
    const second = result.continuation;
    continuations.add(second);
    await first.dispose();
    expect(
      await first.resume({ kind: "resume", config, settledRequests: [] }, { timeoutMs: 7_000 }),
    ).toMatchObject({ status: "failed", code: "runtime_unavailable" });
    result = await second.resume(
      {
        kind: "resume",
        config,
        settledRequests: [{ id: result.pendingRequests[0]!.id, ok: true, json: "null" }],
        pendingRequests: [],
      },
      { timeoutMs: 7_000 },
    );
    expect(result).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: '{"value":3}' },
    });
  });

  it.each(timeoutSources)(
    "interrupts guest execution under the same timeout: %s",
    async (source) => {
      const started = performance.now();
      expect(
        await execute('text("before"); json({ n: 1 }); console.log("diagnostic"); ' + source, {
          executionTimeoutMs: 30,
        }),
      ).toMatchObject({
        status: "failed",
        code: "timeout",
        error: "code mode timeout exceeded",
        failurePhase: "guest",
      });
      // Includes cold Worker startup, but must not spend the 5 s wall budget.
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await execute("return 42")).toMatchObject({
        status: "completed",
        value: { kind: "complete", json: "42" },
      });
    },
  );

  it.for(timeoutSources)(
    "preserves published output when interrupting: %s",
    async (source, { signal }) => {
      const worker = new URL("./code-mode-node.timeout.test-support.ts", import.meta.url);
      const notifications = new BroadcastChannel(randomUUID());
      const environmentKey = "openclaw.codeModeTimeoutOutputTest";
      const previousEnvironment = getEnvironmentData(environmentKey);
      setEnvironmentData(environmentKey, notifications.name);
      const published = createDeferred();
      const consumed = createDeferred();
      const count = source.includes("inherited hook") ? 4 : 3;
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
        const operation = host.run(() =>
          nodeCodeModeExecutor.execute(
            {
              kind: "exec",
              source: 'text("before"); json({ n: 1 }); console.log("diagnostic"); ' + source,
              config,
              catalog: [],
              namespaces: [],
              executionTimeoutMs: 30,
            },
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
          ),
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
          status: "failed",
          code: "timeout",
          error: "code mode timeout exceeded",
          failurePhase: "guest",
          output: {
            count,
            source: {
              kind: "complete",
              json:
                '[{"type":"text","text":"before"},{"type":"json","value":{"n":1}},{"type":"text","text":"diagnostic"}' +
                (source.includes("inherited hook") ? ',{"type":"text","text":"safe"}]' : "]"),
            },
          },
        });
      } finally {
        vi.useRealTimers();
        resolver.mockRestore();
        setEnvironmentData(environmentKey, previousEnvironment);
        notifications.close();
      }
      expect(await execute("return 42")).toMatchObject({
        status: "completed",
        value: { kind: "complete", json: "42" },
      });
    },
  );

  it("creates fresh globals for a reused worker and preserves pure encoding APIs", async () => {
    expect(
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
    ).toMatchObject({ status: "completed", value: { kind: "complete", json: '"hello 🦞"' } });
    expect(
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
    ).toMatchObject({
      status: "completed",
      value: {
        kind: "complete",
        json: '["undefined","undefined","undefined","undefined","undefined","undefined",[240,159,166,158],"🦞"]',
      },
    });
  });

  it.each(["resume", "inline"] as const)(
    "does not replay delivered output when %s times out",
    async (mode) => {
      const input: CodeModeExecutorStartInput = {
        kind: "exec",
        source:
          'text("before"); await yield_control(); text("after"); await yield_control(); while (true) {}',
        config,
        catalog: [],
        namespaces: [],
      };
      const reply = (id: string) => ({ id, ok: true, json: "null" });
      const delivered: unknown[] = [];
      let result = await nodeCodeModeExecutor.execute(input, {
        timeoutMs: 7_000,
        ...(mode === "inline"
          ? {
              inlineHost: {
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
          if (result.status !== "waiting") {
            throw new Error(JSON.stringify(result));
          }
          delivered.push(result.output);
          continuations.add(result.continuation);
          result = await result.continuation.resume(
            {
              kind: "resume",
              config: { ...config, timeoutMs },
              settledRequests: result.pendingRequests.map(({ id }) => reply(id)),
            },
            { timeoutMs: 7_000 },
          );
        }
      }
      expect(delivered).toEqual([
        { count: 1, source: { kind: "complete", json: '[{"type":"text","text":"before"}]' } },
        { count: 1, source: { kind: "complete", json: '[{"type":"text","text":"after"}]' } },
      ]);
      expect(result).toMatchObject({
        status: "failed",
        code: "timeout",
        output: {
          count: 0,
          source: { kind: "complete", json: "[]" },
        },
      });
    },
  );

  it("joins worker cancellation while the host owns a pending bridge exchange", async () => {
    const controller = new AbortController();
    const boundary = createDeferred();
    const result = nodeCodeModeExecutor.execute(
      {
        kind: "exec",
        source: "await yield_control(); return 1;",
        config,
        catalog: [],
        namespaces: [],
      },
      {
        timeoutMs: 7_000,
        signal: controller.signal,
        inlineHost: {
          onBoundary: async (_value, context) => {
            boundary.resolve();
            return new Promise((_resolve, reject) => {
              context.signal.addEventListener(
                "abort",
                () => reject(new Error("Host bridge aborted", { cause: context.signal.reason })),
                { once: true },
              );
            });
          },
        },
      },
    );
    await boundary.promise;
    controller.abort();
    expect(await result).toMatchObject({ status: "failed", code: "aborted" });
    expect(await execute("return 7")).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: "7" },
    });
  });
});
