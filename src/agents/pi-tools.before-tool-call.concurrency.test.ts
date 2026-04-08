import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  __testing as beforeToolCallTesting,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("before_tool_call concurrency discipline", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    beforeToolCallTesting.adjustedParamsByToolCallId.clear();
    beforeToolCallTesting.mutatingToolChainByScope.clear();
  });

  it("serializes mutating tool executions within the same run scope", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const execute = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(30);
      inFlight -= 1;
      return { content: [], details: { ok: true } };
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "write", execute } as any, {
      runId: "run-1",
      sessionId: "sid-1",
      sessionKey: "main",
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    await Promise.all([
      tool.execute("call-1", { path: "a.txt" }, undefined, extensionContext),
      tool.execute("call-2", { path: "b.txt" }, undefined, extensionContext),
    ]);

    expect(maxInFlight).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("allows read-only tools to run in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const execute = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(30);
      inFlight -= 1;
      return { content: [], details: { ok: true } };
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      runId: "run-2",
      sessionId: "sid-2",
      sessionKey: "main",
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    await Promise.all([
      tool.execute("call-r1", { path: "a.txt" }, undefined, extensionContext),
      tool.execute("call-r2", { path: "b.txt" }, undefined, extensionContext),
    ]);

    expect(maxInFlight).toBeGreaterThan(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not block read-only execution behind in-flight mutating tool", async () => {
    let releaseMutating: (() => void) | undefined;
    const mutatingDone = new Promise<void>((resolve) => {
      releaseMutating = resolve;
    });

    const mutatingExecute = vi.fn(async () => {
      await mutatingDone;
      return { content: [], details: { ok: true } };
    });
    const readExecute = vi.fn(async () => ({ content: [], details: { ok: true } }));

    const mutatingTool = wrapToolWithBeforeToolCallHook(
      { name: "edit", execute: mutatingExecute } as any,
      { runId: "run-3", sessionId: "sid-3", sessionKey: "main" },
    );
    const readTool = wrapToolWithBeforeToolCallHook({ name: "read", execute: readExecute } as any, {
      runId: "run-3",
      sessionId: "sid-3",
      sessionKey: "main",
    });

    const extensionContext = {} as Parameters<typeof mutatingTool.execute>[3];
    const mutatingPromise = mutatingTool.execute(
      "call-m",
      { path: "x.txt", old_string: "x", new_string: "y" },
      undefined,
      extensionContext,
    );

    await delay(10);
    await readTool.execute("call-r", { path: "x.txt" }, undefined, extensionContext);

    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(mutatingExecute).toHaveBeenCalledTimes(1);

    if (releaseMutating) {
      releaseMutating();
    }
    await mutatingPromise;
  });
});
