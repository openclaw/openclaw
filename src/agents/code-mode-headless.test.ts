import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CodeModeNamespaceDescriptor } from "./code-mode-namespaces.js";
import { prepareSource } from "./code-mode-source.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "./tool-search.js";
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
    const ctx = createHeadlessCodeModeHarness([first, second]);

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx,
        code: `
          const first = await headless_first({});
          const second = await headless_second({
            value: first.value,
          });
          return second;
        `,
        wallClockMs: 120_000,
      }),
    );

    expect(result.value).toEqual({ input: { value: 2 } });
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("drains a headless nested combinator after its outer race wins", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const nestedStarted = createDeferred();
    const nestedRelease = createDeferred();
    let nestedAborted = false;
    const never = fakeTool("headless_nested_race_never", async (_toolCallId, _input, signal) => {
      events.push("nested:start");
      nestedStarted.resolve();
      signal?.addEventListener(
        "abort",
        () => {
          nestedAborted = true;
          nestedRelease.reject(new Error("aborted"));
        },
        { once: true },
      );
      await nestedRelease.promise;
      events.push("nested:done");
      return jsonResult({ winner: "nested" });
    });
    const fast = fakeTool("headless_nested_race_fast", async () => {
      await nestedStarted.promise;
      events.push("fast:win");
      return jsonResult({ winner: "fast" });
    });
    const release = fakeTool("headless_nested_race_release", async () => {
      events.push("nested:release");
      nestedRelease.resolve();
      return jsonResult({ released: true });
    });

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([never, fast, release]),
        code: `const value = await Promise.race([
            Promise.all([headless_nested_race_never({})]),
            headless_nested_race_fast({}),
          ]);
          void headless_nested_race_release({});
          return value;`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toEqual({ winner: "fast" });
    expect(result.toolCallCount).toBe(3);
    expect(never.execute).toHaveBeenCalledOnce();
    expect(fast.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual(["nested:start", "fast:win", "nested:release", "nested:done"]);
    expect(nestedAborted).toBe(false);
  });

  it.each([
    {
      label: "directly",
      auditCode: "void headless_early_audit({});",
    },
    {
      label: "in a detached already-settled Promise.race",
      auditCode: "void Promise.race([headless_early_audit({}), Promise.resolve()]);",
    },
    {
      label: "in a detached Promise.all",
      auditCode: "void Promise.all([headless_early_audit({})]);",
    },
    {
      label: "in a detached Promise.allSettled",
      auditCode: "void Promise.allSettled([headless_early_audit({})]);",
    },
    {
      label: "in a detached Promise.any",
      auditCode: "void Promise.any([headless_early_audit({})]);",
    },
    {
      label: "in a detached Promise.race",
      auditCode: "void Promise.race([headless_early_audit({})]);",
    },
  ])(
    "drains a headless detached audit started $label before an awaited nested call",
    async ({ auditCode }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const events: string[] = [];
      let auditCompleted = false;
      let auditAborted = false;
      const auditStarted = createDeferred();
      const auditRelease = createDeferred();
      const audit = fakeTool("headless_early_audit", async (_toolCallId, _input, signal) => {
        events.push("audit:start");
        auditStarted.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            auditAborted = true;
            auditRelease.reject(new Error("aborted"));
          },
          { once: true },
        );
        await auditRelease.promise;
        events.push("audit:done");
        auditCompleted = true;
        return jsonResult({ recorded: true });
      });
      const fast = fakeTool("headless_awaited_fast", async () => {
        await auditStarted.promise;
        events.push("awaited:done");
        return jsonResult({ winner: "fast" });
      });
      const release = fakeTool("headless_early_audit_release", async () => {
        events.push("audit:release");
        auditRelease.resolve();
        return jsonResult({ released: true });
      });

      const result = expectCompleted(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([audit, fast, release]),
          code: `${auditCode}
          const value = await headless_awaited_fast({});
          void headless_early_audit_release({});
          return value;`,
          wallClockMs: 5_000,
        }),
      );

      expect(result.value).toEqual({ winner: "fast" });
      expect(result.toolCallCount).toBe(3);
      expect(audit.execute).toHaveBeenCalledOnce();
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(release.execute).toHaveBeenCalledOnce();
      expect(events).toEqual(["audit:start", "awaited:done", "audit:release", "audit:done"]);
      expect(auditCompleted).toBe(true);
      expect(auditAborted).toBe(false);
    },
  );

  it("drains a headless race winner's detached audit and its slower race branch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const loserStarted = createDeferred();
    const loserRelease = createDeferred();
    const auditStarted = createDeferred();
    let loserAborted = false;
    const winner = fakeTool("headless_race_winner", async () => {
      await loserStarted.promise;
      events.push("winner:win");
      return jsonResult({ winner: "fast" });
    });
    const loser = fakeTool("headless_race_loser", async (_toolCallId, _input, signal) => {
      events.push("loser:start");
      loserStarted.resolve();
      signal?.addEventListener(
        "abort",
        () => {
          loserAborted = true;
          loserRelease.reject(new Error("aborted"));
        },
        { once: true },
      );
      await loserRelease.promise;
      events.push("loser:done");
      return jsonResult({ winner: "slow" });
    });
    const audit = fakeTool("headless_race_audit", async () => {
      events.push("audit:done");
      auditStarted.resolve();
      return jsonResult({ recorded: true });
    });
    const release = fakeTool("headless_race_loser_release", async () => {
      await auditStarted.promise;
      events.push("loser:release");
      loserRelease.resolve();
      return jsonResult({ released: true });
    });

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([winner, loser, audit, release]),
        code: `const value = await Promise.race([
            headless_race_winner({}),
            headless_race_loser({}),
          ]);
          void headless_race_audit({});
          void headless_race_loser_release({});
          return value;`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toEqual({ winner: "fast" });
    expect(result.toolCallCount).toBe(4);
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(loser.execute).toHaveBeenCalledOnce();
    expect(audit.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "loser:start",
      "winner:win",
      "audit:done",
      "loser:release",
      "loser:done",
    ]);
    expect(loserAborted).toBe(false);
  });

  it("drains every detached headless tool before completing the guest", async () => {
    const first = fakeTool("headless_detached_first", async () => jsonResult({ name: "first" }));
    const second = fakeTool("headless_detached_second", async () => jsonResult({ name: "second" }));

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([first, second]),
        code: `void headless_detached_first({});
          void headless_detached_second({});
          return "done";`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toBe("done");
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it.each(["race", "any"] as const)(
    "preserves the headless Promise.%s winner while draining the slower nested tool",
    async (combinator) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const events: string[] = [];
      const slowStarted = createDeferred();
      const slowRelease = createDeferred();
      let slowAborted = false;
      let slowCompleted = false;
      const fast = fakeTool("headless_fast", async () => {
        await slowStarted.promise;
        events.push("fast:win");
        return jsonResult({ winner: "fast" });
      });
      const slow = fakeTool("headless_slow", async (_toolCallId, _input, signal) => {
        events.push("slow:start");
        slowStarted.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            slowAborted = true;
            slowRelease.reject(new Error("aborted"));
          },
          { once: true },
        );
        await slowRelease.promise;
        events.push("slow:done");
        slowCompleted = true;
        return jsonResult({ winner: "slow" });
      });
      const release = fakeTool("headless_slow_release", async () => {
        events.push("slow:release");
        slowRelease.resolve();
        return jsonResult({ released: true });
      });

      const result = expectCompleted(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([fast, slow, release]),
          code: `const value = await Promise.${combinator}([
              headless_slow({}),
              headless_fast({}),
            ]);
            void headless_slow_release({});
            return value;`,
          wallClockMs: 5_000,
        }),
      );

      expect(result.value).toEqual({ winner: "fast" });
      expect(result.toolCallCount).toBe(3);
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(release.execute).toHaveBeenCalledOnce();
      expect(events).toEqual(["slow:start", "fast:win", "slow:release", "slow:done"]);
      expect(slowCompleted).toBe(true);
      expect(slowAborted).toBe(false);
    },
  );

  it("preserves headless fail-fast Promise.all while draining the slower nested tool", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const slowStarted = createDeferred();
    const slowRelease = createDeferred();
    let slowAborted = false;
    let slowCompleted = false;
    const failed = fakeTool("headless_failed", async () => {
      events.push("failed:wait");
      await slowStarted.promise;
      events.push("failed:reject");
      throw new Error("fast failure");
    });
    const slow = fakeTool("headless_slow", async (_toolCallId, _input, signal) => {
      events.push("slow:start");
      slowStarted.resolve();
      signal?.addEventListener(
        "abort",
        () => {
          slowAborted = true;
          slowRelease.reject(new Error("aborted"));
        },
        { once: true },
      );
      await slowRelease.promise;
      events.push("slow:done");
      slowCompleted = true;
      return jsonResult({ winner: "slow" });
    });
    const release = fakeTool("headless_slow_release", async () => {
      events.push("slow:release");
      slowRelease.resolve();
      return jsonResult({ released: true });
    });

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([failed, slow, release]),
        code: `try {
          await Promise.all([
            headless_failed({}),
            headless_slow({}),
          ]);
          return "unexpected success";
        } catch (error) {
          void headless_slow_release({});
          return error.message;
        }`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toBe("fast failure");
    expect(result.toolCallCount).toBe(3);
    expect(failed.execute).toHaveBeenCalledOnce();
    expect(slow.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "failed:wait",
      "slow:start",
      "failed:reject",
      "slow:release",
      "slow:done",
    ]);
    expect(slowCompleted).toBe(true);
    expect(slowAborted).toBe(false);
  });

  it.each([
    {
      name: "template-literal import text",
      code: "return `import('node:fs')`;",
      value: "import('node:fs')",
      realHeadless: true,
    },
    {
      name: "regular-expression module text",
      code: 'return /import.meta/.test("import.meta");',
      value: true,
      realHeadless: true,
    },
    {
      name: "ordinary import method",
      code: "const api = { import(value) { return value; } }; return api.import(42);",
      value: 42,
      realHeadless: true,
    },
    {
      name: "ordinary require method",
      code: "const api = { require(value) { return value; } }; return api.require(42);",
      value: 42,
    },
  ])(
    "preserves harmless $name in headless source validation",
    async ({ code, value, realHeadless }) => {
      if (!realHeadless) {
        expect(prepareSource(code)).toBe(code);
        return;
      }
      const result = expectCompleted(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness(),
          code,
        }),
      );

      expect(result.value).toBe(value);
      expect(result.toolCallCount).toBe(0);
    },
  );

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

  it.each(["import('node:fs')", "require('node:fs')"])(
    "rejects astral-shifted JavaScript module access in a headless guest: %s",
    async (moduleAccess) => {
      const result = expectFailed(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness(),
          code: `const padding = "${"😀".repeat(96)}"; return ${moduleAccess};`,
        }),
      );

      expect(result.code).toBe("invalid_input");
      expect(result.error).toContain("module access is disabled");
      expect(result.toolCallCount).toBe(0);
    },
  );

  it("points the model at a tool global when rejecting module access", async () => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness(),
        code: "return require('node:fs');",
      }),
    );

    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("Call an enabled async tool global from guest JavaScript");
    expect(result.error).toContain("Do not retry the same source with require() or an import.");
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
          {
            id: "cron:trigger",
            globalName: "trigger",
            scope: {
              kind: "object",
              entries: [
                [
                  "state",
                  {
                    kind: "value",
                    value: { "": 7, count: 4, nested: { stable: true } },
                  },
                ],
              ],
            },
          },
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
    const extraNamespaces: CodeModeNamespaceDescriptor[] = [
      {
        id: "cron:trigger",
        globalName: "trigger",
        scope: {
          kind: "object",
          entries: [["owner", { kind: "value", value: "namespace" }]],
        },
      },
    ];
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
        extraNamespaces: [
          {
            id: "cron:trigger",
            globalName: "trigger",
            scope: { kind: "object", entries: [] },
          },
          {
            id: "plugin:trigger",
            globalName: "trigger",
            scope: { kind: "object", entries: [] },
          },
        ],
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
    const config = { tools: { codeMode: { enabled: false, timeoutMs: 60_000 } } } as never;
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [strict] });
    const ctx: ToolSearchToolContext = {
      config,
      runtimeConfig: config,
      agentId: "main",
      catalogRef,
    };

    const result = await runCodeModeScriptHeadless({
      ctx,
      code: "return await headless_strict({ value: 42 });",
      wallClockMs: 120_000,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected headless Code Mode failure");
    }
    expect(result.error).toContain("value");
    expect(result.toolCallCount).toBe(1);
    expect(strict.execute).not.toHaveBeenCalled();
  });
});
