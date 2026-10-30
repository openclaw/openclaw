import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createGatedToolFactory } from "./code-mode-concurrency.test-support.js";
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
  assert(result.status === "completed", JSON.stringify(result));
  return result;
}

function expectFailed(result: CodeModeHeadlessResult) {
  assert(result.status === "failed", JSON.stringify(result));
  return result;
}

function run(
  tools: AnyAgentTool[],
  code: string,
  options: Omit<Parameters<typeof runCodeModeScriptHeadless>[0], "ctx" | "code"> = {},
) {
  return runCodeModeScriptHeadless({ ctx: createHeadlessCodeModeHarness(tools), code, ...options });
}

async function complete(...args: Parameters<typeof run>) {
  return expectCompleted(await run(...args));
}

async function fail(...args: Parameters<typeof run>) {
  return expectFailed(await run(...args));
}

function triggerNamespace(
  entries: Extract<CodeModeNamespaceDescriptor["scope"], { kind: "object" }>["entries"],
  id = "cron:trigger",
): CodeModeNamespaceDescriptor {
  return { id, globalName: "trigger", scope: { kind: "object", entries } };
}

const gatedTool = createGatedToolFactory(fakeTool);

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

function drainFixture(label = "slow", winnerEvent = "fast:win") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const events: string[] = [];
  const gate = gatedTool("slow", label, events, { winner: "slow" });
  const fast = fakeTool("fast", async () => {
    await gate.started.promise;
    events.push(winnerEvent);
    return jsonResult({ winner: "fast" });
  });
  const release = releaseTool("release", label, events, gate);
  return { events, gate, fast, release, tools: [gate.tool, fast, release] };
}

function expectDrained(
  result: ReturnType<typeof expectCompleted>,
  fixture: ReturnType<typeof drainFixture>,
  events: string[],
) {
  expect([result.value, result.toolCallCount]).toEqual([{ winner: "fast" }, 3]);
  expectToolCalls(1, ...fixture.tools);
  expect(fixture.events).toEqual(events);
  expect(fixture.gate.state).toEqual({ completed: true, aborted: false });
}

function deadlineFixture(delay: number | null, wallClockMs: number, abortable = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const started = createDeferred();
  const slow = fakeTool("slow_leg", async (_toolCallId, _input, signal) => {
    started.resolve();
    await new Promise<void>((resolve, reject) => {
      if (delay === null) {
        return;
      }
      const timer = setTimeout(resolve, delay);
      if (abortable) {
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }
    });
    return jsonResult({ ok: true });
  });
  return { started, result: run([slow], "await slow_leg({}); return true;", { wallClockMs }) };
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

    expect([result.value, result.toolCallCount]).toEqual([{ input: { value: 2 } }, 2]);
    expectToolCalls(1, first, second);
  });

  it("drains a headless nested combinator after its outer race wins", async () => {
    const fixture = drainFixture("nested");
    const result = await complete(
      fixture.tools,
      `const value = await Promise.race([
            Promise.all([slow({})]),
            fast({}),
          ]);
          void release({});
          return value;`,
      { wallClockMs: 5_000 },
    );

    expectDrained(result, fixture, ["nested:start", "fast:win", "nested:release", "nested:done"]);
  });

  it.each([
    ["directly", "void slow({});"],
    [
      "in a detached already-settled Promise.race",
      "void Promise.race([slow({}), Promise.resolve()]);",
    ],
    ["in a detached Promise.all", "void Promise.all([slow({})]);"],
    ["in a detached Promise.allSettled", "void Promise.allSettled([slow({})]);"],
    ["in a detached Promise.any", "void Promise.any([slow({})]);"],
    ["in a detached Promise.race", "void Promise.race([slow({})]);"],
  ])(
    "drains a headless detached audit started %s before an awaited nested call",
    async (_label, auditCode) => {
      const fixture = drainFixture("audit", "awaited:done");
      const result = await complete(
        fixture.tools,
        `${auditCode}
          const value = await fast({});
          void release({});
          return value;`,
        { wallClockMs: 5_000 },
      );

      expectDrained(result, fixture, [
        "audit:start",
        "awaited:done",
        "audit:release",
        "audit:done",
      ]);
    },
  );

  it("drains a headless race winner's detached audit and its slower race branch", async () => {
    const { events, gate, fast: winner } = drainFixture("loser", "winner:win");
    const loser = gate.tool;
    const auditStarted = createDeferred();
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
            fast({}),
            slow({}),
          ]);
          void headless_race_audit({});
          void headless_race_loser_release({});
          return value;`,
      { wallClockMs: 5_000 },
    );

    expect([result.value, result.toolCallCount]).toEqual([{ winner: "fast" }, 4]);
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
      const fixture = drainFixture();
      const result = await complete(
        fixture.tools,
        `const value = await Promise.${combinator}([
              slow({}),
              fast({}),
            ]);
            void release({});
            return value;`,
        { wallClockMs: 5_000 },
      );

      expectDrained(result, fixture, ["slow:start", "fast:win", "slow:release", "slow:done"]);
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

    expect(result).toMatchObject({ value: "fast failure", toolCallCount: 3 });
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
    const result = await fail([], code);
    expect(result).toMatchObject({ code: "invalid_input", toolCallCount: 0 });
    expect(result.error).toContain("module access is disabled");
  });

  it("injects deeply frozen trigger state and emits replacement state through json", async () => {
    const result = await complete(
      [],
      `
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
      {
        extraNamespaces: [
          triggerNamespace([
            ["state", { kind: "value", value: { "": 7, count: 4, nested: { stable: true } } }],
          ]),
        ],
      },
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
    const runWithNamespace = async () =>
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

    const first = await runWithNamespace();
    const second = await runWithNamespace();

    expect(first.value).toEqual({
      namespaceOwner: "namespace",
      callableName: expect.stringMatching(/^trigger_[a-f0-9]{8}$/u),
      toolResult: { owner: "tool" },
    });
    expect(second.value).toEqual(first.value);
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects colliding injected namespace globals", async () => {
    const result = await fail([], "return true;", {
      extraNamespaces: [triggerNamespace([]), triggerNamespace([], "plugin:trigger")],
    });

    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("namespace collision");
  });

  it("counts first-class node operations against the headless tool budget", async () => {
    const nodesTool = fakeTool("nodes", async () => jsonResult({ nodes: [] }));

    const result = await fail([nodesTool], "await nodes.list(); await nodes.list(); return true;", {
      maxToolCalls: 1,
      wallClockMs: 5_000,
    });

    expect(result).toMatchObject({ code: "tool_budget_exceeded", toolCallCount: 2 });
    expect(nodesTool.execute).toHaveBeenCalledOnce();
  });

  it("honors cron payload tool budgets above the old headless cap", async () => {
    const tool = fakeTool("budgeted", async () => jsonResult({ ok: true }));
    const result = await complete(
      [tool],
      `
          const calls = Array.from({ length: 129 }, () => () => budgeted({}));
          // Keep each leg within the default 16-call pending cap while proving the cumulative budget.
          for (let offset = 0; offset < calls.length; offset += 16) {
            await Promise.all(calls.slice(offset, offset + 16).map((call) => call()));
          }
          return true;
        `,
      {
        maxToolCalls: 200,
        wallClockMs: 120_000,
      },
    );

    expect(result).toMatchObject({ value: true, toolCallCount: 129 });
    expect(tool.execute).toHaveBeenCalledTimes(129);
  });

  it.each([false, true])("enforces the wall deadline with abortable tool=%s", async (abortable) => {
    const fixture = deadlineFixture(abortable ? 30_000 : null, 15_000, abortable);

    // Advance the shared deadline only after the real worker reaches the tool leg.
    await fixture.started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = expectFailed(await fixture.result);

    expect(result).toMatchObject({ code: "timeout", toolCallCount: 1 });
  });

  it("honors cron payload wall-clock limits above the old headless cap", async () => {
    const fixture = deadlineFixture(330_000, 360_000);

    await fixture.started.promise;
    let settled = false;
    void fixture.result.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = expectCompleted(await fixture.result);
    expect(result).toMatchObject({ value: true, toolCallCount: 1 });
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
      ...fakeTool("headless_strict", async () => jsonResult({ unexpected: true })),
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    };
    const result = await fail([strict], "return await headless_strict({ value: 42 });", {
      wallClockMs: 120_000,
    });
    expect(result.error).toContain("value");
    expect(result.toolCallCount).toBe(1);
    expect(strict.execute).not.toHaveBeenCalled();
  });
});
