import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import type { SettledBridgeRequest } from "./code-mode-runtime.js";
import { CodeModeBridgeDispatchQueue } from "./code-mode-state.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function headlessTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(execute) as AnyAgentTool["execute"],
  };
}

function createHeadlessContext(tools: AnyAgentTool[]): ToolSearchToolContext {
  const config = {
    tools: { codeMode: { enabled: false, timeoutMs: 60_000 } },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return {
    config,
    runtimeConfig: config,
    agentId: "main",
    catalogRef,
  };
}

afterEach(() => {
  resetCodeModeTestState();
});

describe("Code Mode cancellation ownership", () => {
  it("does not resume an aborted guest when an active tool ignores cancellation", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 1, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const activeStarted = createDeferred();
    const activeCompletion = createDeferred();
    const activeFinished = createDeferred();
    let activeSawAbort = false;
    const activeTool = pluginToolWithExecute(
      "fake_ignore_cancel",
      "Cancellation-ignoring helper",
      async (_toolCallId, _input, signal) => {
        activeStarted.resolve();
        signal?.addEventListener("abort", () => {
          activeSawAbort = true;
        });
        await activeCompletion.promise;
        activeFinished.resolve();
        return jsonResult({ late: true });
      },
    );
    const queuedTool = pluginTool("fake_queued_after_ignore", "Queued cancellation helper");
    const lateGuestTool = pluginTool("fake_guest_after_abort", "Late guest helper");
    applyCodeModeCatalog({
      tools: [...codeModeTools, activeTool, queuedTool, lateGuestTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    const resultPromise = expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
      "code-call-ignore-cancel",
      {
        code: `
          await Promise.all([
            tools.callValue("fake_ignore_cancel", {}),
            tools.callValue("fake_queued_after_ignore", {}),
          ]);
          return await tools.callValue("fake_guest_after_abort", {});
        `,
      },
      controller.signal,
    );
    await activeStarted.promise;
    controller.abort();
    const details = resultDetails(await resultPromise);

    expect(details).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
    expect(activeSawAbort).toBe(true);
    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();

    activeCompletion.resolve();
    await activeFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("does not resume an aborted headless guest when an active tool ignores cancellation", async () => {
    const activeStarted = createDeferred();
    const activeCompletion = createDeferred();
    const activeFinished = createDeferred();
    let activeSawAbort = false;
    const activeTool = headlessTool(
      "headless_ignore_cancel",
      async (_toolCallId, _input, signal) => {
        activeStarted.resolve();
        signal?.addEventListener("abort", () => {
          activeSawAbort = true;
        });
        await activeCompletion.promise;
        activeFinished.resolve();
        return jsonResult({ late: true });
      },
    );
    const queuedTool = headlessTool("headless_queued_after_ignore", async () =>
      jsonResult({ unexpected: true }),
    );
    const lateGuestTool = headlessTool("headless_guest_after_abort", async () =>
      jsonResult({ unexpected: true }),
    );
    const controller = new AbortController();
    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessContext([activeTool, queuedTool, lateGuestTool]),
      code: `
        await Promise.all([
          tools.callValue("openclaw:core:headless_ignore_cancel", {}),
          tools.callValue("openclaw:core:headless_queued_after_ignore", {}),
        ]);
        return await tools.callValue("openclaw:core:headless_guest_after_abort", {});
      `,
      overrides: { maxPendingToolCalls: 1 },
      wallClockMs: 30_000,
      signal: controller.signal,
    });
    await activeStarted.promise;
    controller.abort();
    const result = await resultPromise;

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
    expect(activeSawAbort).toBe(true);
    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();

    activeCompletion.resolve();
    await activeFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("retains an active slot until a cancelled tool really settles", async () => {
    const queue = new CodeModeBridgeDispatchQueue(1);
    const firstCompletion = createDeferred<SettledBridgeRequest>();
    const cancelActive = vi.fn();
    const first = queue.enqueue({
      id: "bridge:call:1",
      method: "callValue",
      start: () => firstCompletion.promise,
      cancelActive,
    });
    const secondStart = vi.fn(
      async (): Promise<SettledBridgeRequest> => ({
        id: "bridge:call:2",
        ok: true,
        value: "second",
      }),
    );
    const second = queue.enqueue({
      id: "bridge:call:2",
      method: "callValue",
      start: secondStart,
      cancelActive: vi.fn(),
    });

    first.cancel();
    expect(cancelActive).toHaveBeenCalledOnce();
    expect(secondStart).not.toHaveBeenCalled();

    firstCompletion.resolve({ id: "bridge:call:1", ok: true, value: "late success" });

    await expect(first.promise).resolves.toEqual({
      id: "bridge:call:1",
      ok: false,
      error: "code mode bridge call cancelled",
    });
    await expect(second.promise).resolves.toEqual({
      id: "bridge:call:2",
      ok: true,
      value: "second",
    });
    expect(secondStart).toHaveBeenCalledOnce();
  });
});
