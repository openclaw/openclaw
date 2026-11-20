import type { CodeModeWorkerBoundary } from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { assert, describe, expect, it } from "vitest";
import { createQuickJsTestConfig, runQuickJsExecutor } from "./executor.test-support.js";

const config = createQuickJsTestConfig();
const startedAt = 1_700_000_000_000;
const deterministic = { startedAt, seed: 42 };

function execute(
  source: string,
  options: typeof deterministic & { fingerprint?: string } = deterministic,
  onBoundary?: Parameters<typeof runQuickJsExecutor>[4],
) {
  return runQuickJsExecutor(
    { kind: "exec", source, config, catalog: [], deterministic: options },
    10_000,
    undefined,
    undefined,
    onBoundary,
  );
}

function value(result: Awaited<ReturnType<typeof execute>>) {
  assert(result.status === "completed", JSON.stringify(result));
  assert(result.value.kind === "complete");
  return JSON.parse(result.value.json);
}

describe("deterministic QuickJS execution", () => {
  it("replays the same seed, host calls, and ordered virtual-time deliveries", async () => {
    const run = async () => {
      const calls: unknown[] = [];
      const fingerprints: string[] = [];
      let deliveries = 0;
      const result = await execute(
        `typeof WeakRef !== "undefined" && (() => { throw new Error("WeakRef enabled"); })();
        typeof FinalizationRegistry !== "undefined" && (() => { throw new Error("FinalizationRegistry enabled"); })();
        const initial = [Date.now(), new Date().valueOf(), new Date().getTimezoneOffset(), performance.now(), Math.random()];
        const a = await catalog.search(String(Math.random()));
        const afterA = [Date.now(), performance.now()];
        const b = await catalog.search(String(Math.random()));
        return { initial, afterA, final: [Date.now(), performance.now()], a, b };
        `,
        deterministic,
        {
          onBoundary: async (boundary) => {
            fingerprints.push(boundary.deterministicFingerprint!);
            if (!boundary.pendingRequests.length) {
              expect(calls).toHaveLength(0);
              return {
                kind: "continue",
                timeoutMs: 5_000,
                pendingRequests: [],
                settledRequests: [],
              };
            }
            calls.push(...structuredClone(boundary.pendingRequests));
            deliveries++;
            return {
              kind: "continue",
              timeoutMs: 5_000,
              deterministicTimeMs: startedAt + deliveries * 25,
              pendingRequests: [],
              settledRequests: boundary.pendingRequests.map(({ id }) => ({
                id,
                ok: true,
                json: "[]",
              })),
            };
          },
        },
      );
      const completed = value(result);
      expect(fingerprints).toHaveLength(3);
      expect(
        fingerprints.every((fingerprint) => fingerprint === result.deterministicFingerprint),
      ).toBe(true);
      expect(fingerprints[0]).toMatch(/^quickjs-deterministic-v1:[a-f0-9]{64}$/);
      return { result: completed, calls, fingerprint: fingerprints[0] };
    };
    const first = await run();
    expect(first).toEqual(await run());
    expect(first.calls).toHaveLength(2);
    expect(first.result).toMatchObject({
      initial: [startedAt, startedAt, 0, 0, expect.any(Number)],
      afterA: [startedAt + 25, 25],
      final: [startedAt + 50, 50],
      a: [],
      b: [],
    });
  });

  it("changes the random sequence with the seed while leaving virtual time pinned", async () => {
    const script = "return [Date.now(), performance.now(), Math.random(), Math.random()];";
    const first = value(await execute(script));
    const second = value(await execute(script, { ...deterministic, seed: 43 }));
    expect(first.slice(0, 2)).toEqual([startedAt, 0]);
    expect(second.slice(0, 2)).toEqual([startedAt, 0]);
    expect(first.slice(2)).not.toEqual(second.slice(2));
  });

  it("rejects incompatible fingerprints before the first host boundary", async () => {
    let boundaries = 0;
    const result = await execute(
      "await catalog.search('must not dispatch');",
      { ...deterministic, fingerprint: "incompatible" },
      {
        onBoundary: async () => {
          boundaries++;
          return { kind: "checkpoint" };
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      failurePhase: "input",
      bridgeDispatchStarted: false,
      error: expect.stringContaining("fingerprint mismatch"),
    });
    expect(boundaries).toBe(0);
  });

  it("retains deterministic state through an in-process snapshot continuation", async () => {
    let initial = true;
    const parked = await execute(
      "const a = Math.random(); await catalog.search('pause'); return [a, Math.random(), Date.now(), performance.now()];",
      deterministic,
      {
        onBoundary: async () => {
          if (initial) {
            initial = false;
            return { kind: "continue", timeoutMs: 5_000, pendingRequests: [], settledRequests: [] };
          }
          return { kind: "checkpoint" };
        },
      },
    );
    assert(parked.status === "waiting", JSON.stringify(parked));
    const resumed = await runQuickJsExecutor(
      {
        kind: "resume",
        continuation: parked.continuation,
        config,
        deterministicTimeMs: startedAt + 80,
        settledRequests: parked.pendingRequests.map(({ id }) => ({ id, ok: true, json: "[]" })),
      },
      10_000,
    );
    const uninterrupted = await execute(
      "const a = Math.random(); await catalog.search('pause'); return [a, Math.random(), Date.now(), performance.now()];",
      deterministic,
      {
        onBoundary: async (boundary) => ({
          kind: "continue",
          timeoutMs: 5_000,
          deterministicTimeMs: boundary.pendingRequests.length ? startedAt + 80 : startedAt,
          pendingRequests: [],
          settledRequests: boundary.pendingRequests.map(({ id }) => ({ id, ok: true, json: "[]" })),
        }),
      },
    );
    expect(value(resumed)).toEqual(value(uninterrupted));
    expect(value(resumed).slice(2)).toEqual([startedAt + 80, 80]);
  });

  it("rejects backwards virtual time before delivering a host reply", async () => {
    const result = await execute(
      "await catalog.search('pause'); return 'reply delivered';",
      deterministic,
      {
        onBoundary: async (boundary: CodeModeWorkerBoundary) => ({
          kind: "continue",
          timeoutMs: 5_000,
          deterministicTimeMs: startedAt - 1,
          pendingRequests: [],
          settledRequests: boundary.pendingRequests.map(({ id }) => ({ id, ok: true, json: "[]" })),
        }),
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: expect.stringContaining("deterministic time"),
    });
  });
});
