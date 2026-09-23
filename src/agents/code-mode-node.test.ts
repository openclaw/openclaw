import { afterEach, describe, expect, it } from "vitest";
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
afterEach(async () => {
  await Promise.all([...continuations].map((continuation) => continuation.dispose()));
  continuations.clear();
});

function execute(source: string, overrides: Partial<CodeModeExecutorStartInput> = {}) {
  return nodeCodeModeExecutor.execute(
    { kind: "exec", source, config, catalog: [], namespaces: [], ...overrides },
    { timeoutMs: 7_000 },
  );
}

describe("Node Code Mode executor", () => {
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

  it.each([
    "while (true) {}",
    "await null; while (true) {}",
    'Object.prototype.toJSON = () => { throw new Error("inherited hook"); }; text("safe"); while (true) {}',
  ])("interrupts guest execution under the same timeout: %s", async (source) => {
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
      output: {
        count: source.includes("inherited hook") ? 4 : 3,
        source: {
          kind: "complete",
          json:
            '[{"type":"text","text":"before"},{"type":"json","value":{"n":1}},{"type":"text","text":"diagnostic"}' +
            (source.includes("inherited hook") ? ',{"type":"text","text":"safe"}]' : "]"),
        },
      },
    });
    // Includes cold Worker startup, but must not spend the 5 s wall budget.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await execute("return 42")).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: "42" },
    });
  });

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
    "interrupts loops after %s without replaying delivered output",
    async (mode) => {
      const input: CodeModeExecutorStartInput = {
        kind: "exec",
        source: 'text("before"); await yield_control(); text("after"); while (true) {}',
        config,
        catalog: [],
        namespaces: [],
      };
      const reply = (id: string) => ({ id, ok: true, json: "null" });
      let result = await nodeCodeModeExecutor.execute(input, {
        timeoutMs: 7_000,
        ...(mode === "inline"
          ? {
              inlineHost: {
                onBoundary: async (boundary) => {
                  expect(boundary.output.source).toEqual({
                    kind: "complete",
                    json: '[{"type":"text","text":"before"}]',
                  });
                  return {
                    kind: "continue",
                    timeoutMs: 30,
                    pendingRequests: [],
                    settledRequests: boundary.pendingRequests.map(({ id }) => reply(id)),
                  };
                },
              },
            }
          : {}),
      });
      if (mode === "resume") {
        if (result.status !== "waiting") {
          throw new Error(JSON.stringify(result));
        }
        continuations.add(result.continuation);
        result = await result.continuation.resume(
          {
            kind: "resume",
            config: { ...config, timeoutMs: 30 },
            settledRequests: result.pendingRequests.map(({ id }) => reply(id)),
          },
          { timeoutMs: 7_000 },
        );
      }
      expect(result).toMatchObject({
        status: "failed",
        code: "timeout",
        output: {
          count: 1,
          source: { kind: "complete", json: '[{"type":"text","text":"after"}]' },
        },
      });
    },
  );

  it("joins worker cancellation while the host owns a pending bridge exchange", async () => {
    const controller = new AbortController();
    let reachedBoundary!: () => void;
    const boundary = new Promise<void>((resolve) => {
      reachedBoundary = resolve;
    });
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
            reachedBoundary();
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
    await boundary;
    controller.abort();
    expect(await result).toMatchObject({ status: "failed", code: "aborted" });
    expect(await execute("return 7")).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: "7" },
    });
  });
});
