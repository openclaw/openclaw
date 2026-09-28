/** Tests Code Mode runtime and output limits. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeModeFailureCode } from "./code-mode-errors.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { applyCodeModeCatalog, createCodeModeTools, resolveCodeModeConfig } from "./code-mode.js";
import {
  expectOriginalCodeModeMarker,
  expectCodeModeSharedBudget,
  resetCodeModeTestState,
  pluginTool,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { createToolSearchCatalogRef } from "./tool-search.js";

function createLimitsHarness(limits: { maxOutputBytes?: number; timeoutMs?: number }) {
  const config = { tools: { codeMode: { enabled: true, ...limits } } };
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "session-code-mode",
    sessionKey: "agent:main:main",
    runId: "run-code-mode",
    catalogRef: createToolSearchCatalogRef(),
  };
  return { config, ctx, tools: createCodeModeTools(ctx) };
}

describe("Code Mode runtime and output limits", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetCodeModeTestState();
  });

  it("bounds oversized values on completed exec calls", async () => {
    const { ctx, config, tools } = createLimitsHarness({ maxOutputBytes: 1024 });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, pluginTool("fake_noop", "Noop")] });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-large", {
        code: "return 'x'.repeat(2048);",
      }),
    );

    expect(details.status).toBe("completed");
    expect(details.value).toMatchObject({
      truncated: true,
      guidance: expect.stringContaining("rerun with narrower args"),
    });
  });

  it("bounds oversized output before suspending runs", async () => {
    const { ctx, config, tools } = createLimitsHarness({ maxOutputBytes: 1024 });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, pluginTool("fake_noop", "Noop")] });

    const beforeRunCount = testing.activeRuns.size;
    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-large-suspend", {
        code: "text('x'.repeat(2048)); await yield_control('pause'); return 1;",
      }),
    );

    expect(details.status).toBe("waiting");
    expect(JSON.stringify(details.output)).toContain("rerun with narrower args");
    expect(testing.activeRuns.size).toBe(beforeRunCount + 1);

    const completed = resultDetails(
      await expectDefined(tools[1], "Code Mode wait test invariant").execute(
        "code-wait-large-suspend",
        { runId: details.runId },
      ),
    );
    expect(completed.status).toBe("completed");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
  });

  it.each([
    { name: "original 1KiB", cap: 1024, firstText: "🦞".repeat(140), lastText: "é".repeat(240) },
    {
      name: "default budget",
      cap: undefined,
      firstText: "🦞".repeat(9000),
      lastText: "é".repeat(18000),
    },
    {
      name: "clipped first leg",
      cap: 1024,
      firstText: "🦞".repeat(1000),
      lastText: '\\"\n\té'.repeat(30),
    },
  ])(
    "bounds cumulative original output across yielded waits: $name",
    async ({ cap, firstText, lastText }) => {
      const { ctx } = createCodeModeHarness();
      const config = {
        tools: { codeMode: { enabled: true, ...(cap ? { maxOutputBytes: cap } : {}) } },
      };
      const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
      applyCodeModeCatalog({ ...ctx, config, tools });
      const exec = expectDefined(tools[0], "exec");
      const wait = expectDefined(tools[1], "wait");
      const original = [
        { type: "text", text: firstText },
        { type: "text", text: lastText },
      ];
      const first = resultDetails(
        await exec.execute("cumulative", {
          code: `text(${JSON.stringify(firstText)}); await yield_control(); await yield_control(); text(${JSON.stringify(lastText)}); await yield_control(); return true;`,
        }),
      );
      expect(first.status).toBe("waiting");
      if (Buffer.byteLength(JSON.stringify([original[0]])) > (cap ?? 65536)) {
        expectOriginalCodeModeMarker((first.output as unknown[])[0], [original[0]]);
      } else {
        expect(first.output).toEqual([original[0]]);
      }
      const empty = resultDetails(await wait.execute("empty-leg", { runId: first.runId }));
      expect(empty.status).toBe("waiting");
      expect(empty.output).toEqual([]);
      const changed = resultDetails(await wait.execute("new-leg", { runId: first.runId }));
      expect(changed.status).toBe("waiting");
      expectOriginalCodeModeMarker((changed.output as unknown[])[0], original);
      const final = resultDetails(await wait.execute("final", { runId: first.runId }));
      expect(final.status).toBe("completed");
      expect(final.value).toBe(true);
      expectOriginalCodeModeMarker((final.output as unknown[])[0], original);
      for (const frame of [first, empty, changed, final]) {
        expectCodeModeSharedBudget(frame, cap ?? 65536);
      }
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("bounds output before auto-draining namespace calls", async () => {
    const { ctx, config, tools } = createLimitsHarness({ maxOutputBytes: 1024 });
    const executeListIssues = vi.fn(async () =>
      projectMcpCallToolResult({ content: [{ type: "text", text: '{"ok":true}' }] }),
    );
    const listIssues = mcpTool({
      name: "tickets__list",
      serverName: "tickets",
      toolName: "list",
      execute: executeListIssues,
    });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, listIssues] });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-large-namespace",
        {
          code: 'text("x".repeat(2048)); await MCP.tickets.list({ state: "open" }); return 1;',
        },
      ),
    );

    expect(details.status).toBe("completed");
    expect(JSON.stringify(details.output)).toContain("rerun with narrower args");
    expect(executeListIssues).toHaveBeenCalledOnce();
  });

  it("preserves guest output when a run fails", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-output-before-error",
        {
          code: 'text("before"); throw new Error("boom");',
        },
      ),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("Error: boom");
    expect(details.output).toEqual([{ type: "text", text: "before" }]);
    expect(details.failurePhase).toBe("guest");
    expect(details.bridgeDispatchStarted).toBe(false);
  });

  it("terminates hostile infinite loops outside the main event loop", async () => {
    const { ctx, config, tools } = createLimitsHarness({ timeoutMs: 100 });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, pluginTool("fake_noop", "Noop")] });

    const heartbeat = Promise.resolve("main-event-loop-alive");
    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-loop", {
        code: "while (true) {}",
      }),
    );

    await expect(heartbeat).resolves.toBe("main-event-loop-alive");
    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("timeout exceeded");
    expect(details.code).toBe("timeout");
  });

  it("normalizes QuickJS interrupt timeout errors", () => {
    expect(
      codeModeFailureCode(new Error("interrupted", { cause: new Error("worker stopped") })),
    ).toBe("timeout");
    expect(
      testing.normalizeCodeModeTimeoutResult({
        status: "failed",
        code: "timeout",
        error: "interrupted",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: EMPTY_CODE_MODE_OUTPUT,
      }),
    ).toMatchObject({
      code: "timeout",
      error: "code mode timeout exceeded",
    });

    expect(
      testing.normalizeCodeModeTimeoutResult({
        status: "failed",
        code: "internal_error",
        error: "interrupted",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: EMPTY_CODE_MODE_OUTPUT,
      }),
    ).toMatchObject({
      code: "internal_error",
      error: "interrupted",
    });
  });

  it("does not classify guest interrupted errors as timeouts", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

    const result = await testing.runCodeModeExecutor(
      {
        kind: "exec",
        source: 'throw new Error("interrupted");',
        config,
        catalog: [],
        namespaces: [],
      },
      { timeoutMs: 10_000, executor: config.executor },
    );

    expect(result.status).toBe("failed");
    // A guest error whose message happens to be "interrupted" must stay
    // internal_error and not be misclassified as a QuickJS interrupt/timeout.
    expect(result).toMatchObject({ code: "internal_error" });
    if (result.status === "failed") {
      expect(result.error).toContain("interrupted");
    }
  });
});
