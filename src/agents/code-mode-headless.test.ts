import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CodeModeNamespaceDescriptor } from "./code-mode-namespaces.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  expectToolCalls,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(execute) as AnyAgentTool["execute"],
  };
}

function expectCompleted(result: CodeModeHeadlessResult) {
  expect(result.status).toBe("completed");
  if (result.status !== "completed") {
    throw new Error(result.error);
  }
  return result;
}

function expectFailed(result: CodeModeHeadlessResult) {
  expect(result.status).toBe("failed");
  if (result.status !== "failed") {
    throw new Error("expected headless code mode failure");
  }
  return result;
}

async function complete(
  tools: AnyAgentTool[],
  code: string,
  options: Omit<Parameters<typeof runCodeModeScriptHeadless>[0], "ctx" | "code">,
) {
  return expectCompleted(
    await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(tools),
      code,
      ...options,
    }),
  );
}

function triggerNamespace(
  entries: Extract<CodeModeNamespaceDescriptor["scope"], { kind: "object" }>["entries"],
  id = "cron:trigger",
): CodeModeNamespaceDescriptor {
  return { id, globalName: "trigger", scope: { kind: "object", entries } };
}

function gatedTool(name: string, label: string, events: string[], value: unknown) {
  const started = createDeferred();
  const release = createDeferred();
  const state = { aborted: false, completed: false };
  const tool = fakeTool(name, async (_id, _input, signal) => {
    events.push(`${label}:start`);
    started.resolve();
    signal?.addEventListener(
      "abort",
      () => {
        state.aborted = true;
        release.reject(new Error("aborted"));
      },
      { once: true },
    );
    await release.promise;
    events.push(`${label}:done`);
    state.completed = true;
    return jsonResult(value);
  });
  return { tool, started, release, state };
}

function releaseTool(
  name: string,
  label: string,
  events: string[],
  gate: ReturnType<typeof gatedTool>,
) {
  return fakeTool(name, async () => {
    events.push(`${label}:release`);
    gate.release.resolve();
    return jsonResult({ released: true });
  });
}

describe("headless Code Mode", () => {
  afterEach(async () => {
    vi.useRealTimers();
    try {
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      await resetCodeModeTestState();
    }
  });

  it("completes multi-round tool calls without publishing active runs", async () => {
    const first = fakeTool("headless_first", async () => {
      expect(testing.activeRuns.size).toBe(0);
      return jsonResult({ value: 2 });
    });
    const second = fakeTool("headless_second", async (_toolCallId, input) => {
      expect(testing.activeRuns.size).toBe(0);
      return jsonResult({ input });
    });
    const result = await complete(
      [first, second],
      `
          const first = await headless_first({});
          const second = await headless_second({
            value: first.value,
          });
          return second;
        `,
      { wallClockMs: 120_000 },
    );

    expect(result.value).toEqual({ input: { value: 2 } });
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("drains a headless nested combinator after its outer race wins", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const nested = gatedTool("headless_nested_race_never", "nested", events, { winner: "nested" });
    const never = nested.tool;
    const fast = fakeTool("headless_nested_race_fast", async () => {
      await nested.started.promise;
      events.push("fast:win");
      return jsonResult({ winner: "fast" });
    });
    const release = releaseTool("headless_nested_race_release", "nested", events, nested);

    const result = await complete(
      [never, fast, release],
      `const value = await Promise.race([
            Promise.all([headless_nested_race_never({})]),
            headless_nested_race_fast({}),
          ]);
          void headless_nested_race_release({});
          return value;`,
      { wallClockMs: 5_000 },
    );

    expect(result.value).toEqual({ winner: "fast" });
    expect(result.toolCallCount).toBe(3);
    expectToolCalls(1, never, fast, release);
    expect(events).toEqual(["nested:start", "fast:win", "nested:release", "nested:done"]);
    expect(nested.state.aborted).toBe(false);
  });

  it.each([
    ["directly", "void headless_early_audit({});"],
    [
      "in a detached already-settled Promise.race",
      "void Promise.race([headless_early_audit({}), Promise.resolve()]);",
    ],
    ["in a detached Promise.all", "void Promise.all([headless_early_audit({})]);"],
    ["in a detached Promise.allSettled", "void Promise.allSettled([headless_early_audit({})]);"],
    ["in a detached Promise.any", "void Promise.any([headless_early_audit({})]);"],
    ["in a detached Promise.race", "void Promise.race([headless_early_audit({})]);"],
  ])(
    "drains a headless detached audit started %s before an awaited nested call",
    async (_label, auditCode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const events: string[] = [];
      const gate = gatedTool("headless_early_audit", "audit", events, { recorded: true });
      const audit = gate.tool;
      const fast = fakeTool("headless_awaited_fast", async () => {
        await gate.started.promise;
        events.push("awaited:done");
        return jsonResult({ winner: "fast" });
      });
      const release = releaseTool("headless_early_audit_release", "audit", events, gate);

      const result = await complete(
        [audit, fast, release],
        `${auditCode}
          const value = await headless_awaited_fast({});
          void headless_early_audit_release({});
          return value;`,
        { wallClockMs: 5_000 },
      );

      expect(result.value).toEqual({ winner: "fast" });
      expect(result.toolCallCount).toBe(3);
      expectToolCalls(1, audit, fast, release);
      expect(events).toEqual(["audit:start", "awaited:done", "audit:release", "audit:done"]);
      expect(gate.state).toEqual({ completed: true, aborted: false });
    },
  );

  it("drains a headless race winner's detached audit and its slower race branch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const gate = gatedTool("headless_race_loser", "loser", events, { winner: "slow" });
    const loser = gate.tool;
    const auditStarted = createDeferred();
    const winner = fakeTool("headless_race_winner", async () => {
      await gate.started.promise;
      events.push("winner:win");
      return jsonResult({ winner: "fast" });
    });
    const audit = fakeTool("headless_race_audit", async () => {
      events.push("audit:done");
      auditStarted.resolve();
      return jsonResult({ recorded: true });
    });
    const release = fakeTool("headless_race_loser_release", async () => {
      await auditStarted.promise;
      events.push("loser:release");
      gate.release.resolve();
      return jsonResult({ released: true });
    });

    const result = await complete(
      [winner, loser, audit, release],
      `const value = await Promise.race([
            headless_race_winner({}),
            headless_race_loser({}),
          ]);
          void headless_race_audit({});
          void headless_race_loser_release({});
          return value;`,
      { wallClockMs: 5_000 },
    );

    expect(result.value).toEqual({ winner: "fast" });
    expect(result.toolCallCount).toBe(4);
    expectToolCalls(1, winner, loser, audit, release);
    expect(events).toEqual([
      "loser:start",
      "winner:win",
      "audit:done",
      "loser:release",
      "loser:done",
    ]);
    expect(gate.state.aborted).toBe(false);
  });

  it.each(["race", "any"] as const)(
    "preserves the headless Promise.%s winner while draining the slower nested tool",
    async (combinator) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const events: string[] = [];
      const gate = gatedTool("headless_slow", "slow", events, { winner: "slow" });
      const slow = gate.tool;
      const fast = fakeTool("headless_fast", async () => {
        await gate.started.promise;
        events.push("fast:win");
        return jsonResult({ winner: "fast" });
      });
      const release = releaseTool("headless_slow_release", "slow", events, gate);

      const result = await complete(
        [fast, slow, release],
        `const value = await Promise.${combinator}([
              headless_slow({}),
              headless_fast({}),
            ]);
            void headless_slow_release({});
            return value;`,
        { wallClockMs: 5_000 },
      );

      expect(result.value).toEqual({ winner: "fast" });
      expect(result.toolCallCount).toBe(3);
      expectToolCalls(1, fast, slow, release);
      expect(events).toEqual(["slow:start", "fast:win", "slow:release", "slow:done"]);
      expect(gate.state).toEqual({ completed: true, aborted: false });
    },
  );

  it("preserves headless fail-fast Promise.all while draining the slower nested tool", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const gate = gatedTool("headless_slow", "slow", events, { winner: "slow" });
    const slow = gate.tool;
    const failed = fakeTool("headless_failed", async () => {
      events.push("failed:wait");
      await gate.started.promise;
      events.push("failed:reject");
      throw new Error("fast failure");
    });
    const release = releaseTool("headless_slow_release", "slow", events, gate);

    const result = await complete(
      [failed, slow, release],
      `try {
          await Promise.all([
            headless_failed({}),
            headless_slow({}),
          ]);
          return "unexpected success";
        } catch (error) {
          void headless_slow_release({});
          return error.message;
        }`,
      { wallClockMs: 5_000 },
    );

    expect(result.value).toBe("fast failure");
    expect(result.toolCallCount).toBe(3);
    expectToolCalls(1, failed, slow, release);
    expect(events).toEqual([
      "failed:wait",
      "slow:start",
      "failed:reject",
      "slow:release",
      "slow:done",
    ]);
    expect(gate.state).toEqual({ completed: true, aborted: false });
  });

  it.each([
    String.raw`return r\u0065quire('node:fs');`,
    "return require?.('node:fs');",
    "return (0, require)('node:fs');",
    "const load = require; return load('node:fs');",
    "return module.require('node:fs');",
    "return process.getBuiltinModule('node:fs');",
    "return `${`nested ${import('node:fs')}`}`;",
  ])("rejects executable module access in a headless guest: %s", async (code) => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness(),
        code,
      }),
    );

    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("module access is disabled");
    expect(result.toolCallCount).toBe(0);
  });

  it("injects deeply frozen trigger state and emits replacement state through json", async () => {
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness(),
        code: `
          json({
            fire: true,
            frozen: Object.isFrozen(trigger) &&
              Object.isFrozen(trigger.state) &&
              Object.isFrozen(trigger.state.nested),
            emptyKey: trigger.state[""],
            state: { count: trigger.state.count + 1 },
          });
          return "done";
        `,
        extraNamespaces: [
          triggerNamespace([
            ["state", { kind: "value", value: { "": 7, count: 4, nested: { stable: true } } }],
          ]),
        ],
      }),
    );

    expect(result.output).toEqual([
      {
        type: "json",
        value: { fire: true, frozen: true, emptyKey: 7, state: { count: 5 } },
      },
    ]);
  });

  it("keeps an injected namespace while calling a colliding tool by its advertised global", async () => {
    const tool = fakeTool("trigger", async () => jsonResult({ owner: "tool" }));
    const ctx = createHeadlessCodeModeHarness([tool]);
    const extraNamespaces = [triggerNamespace([["owner", { kind: "value", value: "namespace" }]])];
    const run = async () =>
      expectCompleted(
        await runCodeModeScriptHeadless({
          ctx,
          extraNamespaces,
          code: `
            const handle = catalog.all().find((entry) => entry.toolName === "trigger");
            if (!handle) throw new Error("trigger tool missing");
            return {
              namespaceOwner: trigger.owner,
              callableName: handle.callableName,
              toolResult: await globalThis[handle.callableName]({}),
            };
          `,
          wallClockMs: 120_000,
        }),
      );

    const first = await run();
    const second = await run();

    expect(first.value).toEqual({
      namespaceOwner: "namespace",
      callableName: expect.stringMatching(/^trigger_[a-f0-9]{8}$/u),
      toolResult: { owner: "tool" },
    });
    expect(second.value).toEqual(first.value);
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects colliding injected namespace globals", async () => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness(),
        code: "return true;",
        extraNamespaces: [triggerNamespace([]), triggerNamespace([], "plugin:trigger")],
      }),
    );

    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("namespace collision");
  });

  it("counts first-class node operations against the headless tool budget", async () => {
    const nodesTool = fakeTool("nodes", async () => jsonResult({ nodes: [] }));

    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([nodesTool]),
        code: `
          await nodes.list();
          await nodes.list();
          return true;
        `,
        maxToolCalls: 1,
        wallClockMs: 5_000,
      }),
    );

    expect(result.code).toBe("tool_budget_exceeded");
    expect(result.toolCallCount).toBe(2);
    expect(nodesTool.execute).toHaveBeenCalledOnce();
  });

  it("honors cron payload tool budgets above the old headless cap", async () => {
    const tool = fakeTool("budgeted", async () => jsonResult({ ok: true }));
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([tool]),
        code: `
          const calls = Array.from({ length: 129 }, () => () =>
            budgeted({}),
          );
          // Keep each leg within the default 16-call pending cap while proving the cumulative budget.
          for (let offset = 0; offset < calls.length; offset += 16) {
            await Promise.all(calls.slice(offset, offset + 16).map((call) => call()));
          }
          return true;
        `,
        maxToolCalls: 200,
        wallClockMs: 120_000,
      }),
    );

    expect(result.value).toBe(true);
    expect(result.toolCallCount).toBe(129);
    expect(tool.execute).toHaveBeenCalledTimes(129);
  });

  it("enforces one wall-clock deadline across worker and tool legs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const toolStarted = createDeferred();
    const slow = fakeTool("slow_leg", async (_toolCallId, _input, signal) => {
      toolStarted.resolve();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return jsonResult({ ok: true });
    });
    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness([slow]),
      code: `
        await slow_leg({});
        return true;
      `,
      wallClockMs: 15_000,
    });

    // Advance the shared deadline only after the real worker reaches the tool leg.
    await toolStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = expectFailed(await resultPromise);

    expect(result.code).toBe("timeout");
    expect(result.toolCallCount).toBe(1);
  });

  it("honors cron payload wall-clock limits above the old headless cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const toolStarted = createDeferred();
    const slow = fakeTool("slow_leg", async () => {
      toolStarted.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 330_000);
      });
      return jsonResult({ ok: true });
    });
    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness([slow]),
      code: `
        await slow_leg({});
        return true;
      `,
      wallClockMs: 360_000,
    });

    await toolStarted.promise;
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = expectCompleted(await resultPromise);
    expect(result.value).toBe(true);
    expect(result.toolCallCount).toBe(1);
  });

  it("keeps worker-leg wall-clock expiry classified as timeout", async () => {
    const ctx = createHeadlessCodeModeHarness();
    expectCompleted(await runCodeModeScriptHeadless({ ctx, code: "return true;" }));

    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx,
        code: "while (true) {}",
        wallClockMs: 100,
      }),
    );

    expect(result.code).toBe("timeout");
    expect(result.error).toContain("timeout exceeded");
  });

  it("rejects schema-invalid nested input before headless tool execution", async () => {
    const strict: AnyAgentTool = {
      name: "headless_strict",
      label: "headless_strict",
      description: "Strict headless test tool",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      execute: vi.fn(async () => jsonResult({ unexpected: true })),
    };
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([strict]),
        code: "return await headless_strict({ value: 42 });",
        wallClockMs: 120_000,
      }),
    );
    expect(result.error).toContain("value");
    expect(result.toolCallCount).toBe(1);
    expect(strict.execute).not.toHaveBeenCalled();
  });
});
