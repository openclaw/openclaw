import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  __testing as beforeToolCallTesting,
  wrapToolWithBeforeToolCallHook,
  type HookContext,
} from "./pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

type HookRunnerMock = {
  hasHooks: ReturnType<typeof vi.fn>;
  runBeforeToolCall: ReturnType<typeof vi.fn>;
};

function installMockHookRunner(hasHooksReturn = true) {
  const hookRunner: HookRunnerMock = {
    hasHooks: vi.fn(() => hasHooksReturn),
    runBeforeToolCall: vi.fn().mockResolvedValue(undefined),
  };
  mockGetGlobalHookRunner.mockReturnValue(
    hookRunner as unknown as ReturnType<typeof getGlobalHookRunner>,
  );
  return hookRunner;
}

function createWrappedTool(name: string, ctx: HookContext) {
  const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
  return wrapToolWithBeforeToolCallHook({ name, execute } as unknown as AnyAgentTool, ctx);
}

describe("before_tool_call external data tracking", () => {
  let hookRunner: HookRunnerMock;

  beforeEach(() => {
    hookRunner = installMockHookRunner(true);
    beforeToolCallTesting.externalDataSourcesByScope.clear();
  });

  it("sets hasExternalData=false when no external tools have been called", async () => {
    const ctx: HookContext = { runId: "run-none" };
    const tool = createWrappedTool("read", ctx);

    await tool.execute("call-none", { path: "/tmp/a.txt" }, undefined, undefined);

    expect(hookRunner.runBeforeToolCall).toHaveBeenCalledTimes(1);
    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls[0] as [unknown, HookContext];
    expect(toolContext.hasExternalData).toBe(false);
  });

  it("sets hasExternalData=true after web_fetch is called", async () => {
    const ctx: HookContext = { runId: "run-web-fetch" };
    const fetchTool = createWrappedTool("web_fetch", ctx);
    const readTool = createWrappedTool("read", ctx);

    await fetchTool.execute("call-fetch", { url: "https://example.com" }, undefined, undefined);
    await readTool.execute("call-read", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls.at(-1) as [
      unknown,
      HookContext,
    ];
    expect(toolContext.hasExternalData).toBe(true);
  });

  it("sets hasExternalData=true after web_search is called", async () => {
    const ctx: HookContext = { runId: "run-web-search" };
    const searchTool = createWrappedTool("web_search", ctx);
    const readTool = createWrappedTool("read", ctx);

    await searchTool.execute("call-search", { query: "openclaw" }, undefined, undefined);
    await readTool.execute("call-read", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls.at(-1) as [
      unknown,
      HookContext,
    ];
    expect(toolContext.hasExternalData).toBe(true);
  });

  it("sets hasExternalData=true after browser is called", async () => {
    const ctx: HookContext = { runId: "run-browser" };
    const browserTool = createWrappedTool("browser", ctx);
    const readTool = createWrappedTool("read", ctx);

    await browserTool.execute("call-browser", { action: "open" }, undefined, undefined);
    await readTool.execute("call-read", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls.at(-1) as [
      unknown,
      HookContext,
    ];
    expect(toolContext.hasExternalData).toBe(true);
  });

  it("keeps hasExternalData=false after read is called", async () => {
    const ctx: HookContext = { runId: "run-read" };
    const readTool = createWrappedTool("read", ctx);

    await readTool.execute("call-read-1", { path: "/tmp/a.txt" }, undefined, undefined);
    await readTool.execute("call-read-2", { path: "/tmp/b.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls.at(-1) as [
      unknown,
      HookContext,
    ];
    expect(toolContext.hasExternalData).toBe(false);
  });

  it("keeps hasExternalData=false after exec is called", async () => {
    const ctx: HookContext = { runId: "run-exec" };
    const execTool = createWrappedTool("exec", ctx);
    const readTool = createWrappedTool("read", ctx);

    await execTool.execute("call-exec", { cmd: "ls" }, undefined, undefined);
    await readTool.execute("call-read", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls.at(-1) as [
      unknown,
      HookContext,
    ];
    expect(toolContext.hasExternalData).toBe(false);
  });

  it("keeps hasExternalData=false when external tool execution fails", async () => {
    const ctx: HookContext = { sessionId: "sess-failing-external" };
    const failingFetchExecute = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const failingFetchTool = wrapToolWithBeforeToolCallHook(
      { name: "web_fetch", execute: failingFetchExecute } as unknown as AnyAgentTool,
      ctx,
    );
    const readTool = createWrappedTool("read", ctx);

    await expect(
      failingFetchTool.execute(
        "call-fetch-fail",
        { url: "https://example.com" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("fetch failed");
    await readTool.execute("call-read-after-fail", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls.at(-1) as [
      unknown,
      HookContext,
    ];
    expect(toolContext.hasExternalData).toBe(false);
  });

  it("keeps external-data state isolated across scopes", async () => {
    const ctxA: HookContext = { runId: "run-a" };
    const ctxB: HookContext = { runId: "run-b" };
    const fetchToolA = createWrappedTool("web_fetch", ctxA);
    const readToolA = createWrappedTool("read", ctxA);
    const readToolB = createWrappedTool("read", ctxB);

    await fetchToolA.execute("call-fetch-a", { url: "https://example.com" }, undefined, undefined);
    await readToolB.execute("call-read-b", { path: "/tmp/b.txt" }, undefined, undefined);
    await readToolA.execute("call-read-a", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, contextForB] = hookRunner.runBeforeToolCall.mock.calls[1] as [unknown, HookContext];
    const [, contextForA] = hookRunner.runBeforeToolCall.mock.calls[2] as [unknown, HookContext];
    expect(contextForB.hasExternalData).toBe(false);
    expect(contextForA.hasExternalData).toBe(true);
  });

  it("evicts oldest scopes when tracked external-data scopes exceed cap", async () => {
    installMockHookRunner(false);
    const maxScopes = beforeToolCallTesting.MAX_TRACKED_EXTERNAL_DATA_SCOPES;
    const totalScopes = maxScopes + 1;

    for (let i = 0; i < totalScopes; i += 1) {
      const ctx: HookContext = { runId: `run-${i}` };
      const fetchTool = createWrappedTool("web_fetch", ctx);
      await fetchTool.execute(
        `call-${i}`,
        { url: `https://example.com/${i}` },
        undefined,
        undefined,
      );
    }

    const oldestKey = beforeToolCallTesting.buildHookContextScopeKey({ runId: "run-0" });
    const newestKey = beforeToolCallTesting.buildHookContextScopeKey({
      runId: `run-${totalScopes - 1}`,
    });
    expect(beforeToolCallTesting.externalDataSourcesByScope.size).toBe(maxScopes);
    expect(oldestKey).toBeDefined();
    expect(newestKey).toBeDefined();
    expect(beforeToolCallTesting.externalDataSourcesByScope.has(oldestKey!)).toBe(false);
    expect(beforeToolCallTesting.externalDataSourcesByScope.has(newestKey!)).toBe(true);
  });

  it("passes turnSource fields through to runBeforeToolCall tool context", async () => {
    const ctx: HookContext = {
      sessionId: "sess-turn-source",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "channel-123",
      turnSourceAccountId: "account-abc",
      turnSourceThreadId: 42,
    };
    const tool = createWrappedTool("read", ctx);

    await tool.execute("call-turn-source", { path: "/tmp/a.txt" }, undefined, undefined);

    const [, toolContext] = hookRunner.runBeforeToolCall.mock.calls[0] as [unknown, HookContext];
    expect(toolContext.turnSourceChannel).toBe("whatsapp");
    expect(toolContext.turnSourceTo).toBe("channel-123");
    expect(toolContext.turnSourceAccountId).toBe("account-abc");
    expect(toolContext.turnSourceThreadId).toBe(42);
  });
});
