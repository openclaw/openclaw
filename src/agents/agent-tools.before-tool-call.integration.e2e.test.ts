/**
 * End-to-end coverage for before_tool_call hook integration.
 * Exercises runtime wrapping, client-tool adaptation, code-mode params, and
 * adjusted parameter handoff across the tool boundary.
 */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { patchPluginSessionExtension } from "../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { PluginHookRegistration } from "../plugins/types.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { toClientToolDefinitions, toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { bindAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  finalizeToolTerminalPresentation,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import {
  buildAdjustedParamsKey,
  consumeTrackedToolExecutionStarted,
  resetAdjustedParamsByToolCallIdForTests,
  structuredReplaySafeToolCallIds,
} from "./agent-tools.before-tool-call.state.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { CODE_MODE_EXEC_TOOL_NAME, createCodeModeTools } from "./code-mode.js";
import { getInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import type { ExtensionContext } from "./sessions/index.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { hashToolCall, recordToolCall } from "./tool-loop-detection.js";
import { createToolSearchCatalogRef, registerHeadlessToolSearchCatalog } from "./tool-search.js";
import { setToolTerminalPresentation } from "./tool-terminal-presentation.js";

type BeforeToolCallHandlerMock = ReturnType<typeof vi.fn>;
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-client-tool-policy-");

function asAgentTool(tool: {
  description?: string;
  execute: ReturnType<typeof vi.fn>;
  name: string;
  parameters?: object;
  resultContentSource?: AnyAgentTool["resultContentSource"];
}): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

type BeforeToolCallHookInstall = {
  pluginId: string;
  priority?: number;
  handler: BeforeToolCallHandlerMock;
};

function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

function installBeforeToolCallHook(params?: {
  enabled?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): BeforeToolCallHandlerMock {
  resetGlobalHookRunner();
  const handler = params?.runBeforeToolCallImpl
    ? vi.fn(params.runBeforeToolCallImpl)
    : vi.fn(async () => undefined);
  if (params?.enabled === false) {
    return handler;
  }
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

function installBeforeToolCallHooks(hooks: BeforeToolCallHookInstall[]): void {
  resetGlobalHookRunner();
  const registry = createEmptyPluginRegistry();
  for (const hook of hooks) {
    addTestHook({
      registry,
      pluginId: hook.pluginId,
      hookName: "before_tool_call",
      handler: hook.handler as PluginHookRegistration["handler"],
      priority: hook.priority,
    });
  }
  initializeGlobalHookRunner(registry);
}

function clientToolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): Parameters<typeof toClientToolDefinitions>[0][number] {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties } },
  };
}

describe("before_tool_call hook integration", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    resetAdjustedParamsByToolCallIdForTests();
    resetDiagnosticEventsForTest();
    beforeToolCallHook = installBeforeToolCallHook();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("validates final execution arguments before starting the tool", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "Read", execute }));
    const validate = vi.fn(() => {
      throw new Error("invalid projected arguments");
    });
    await expect(
      runWithToolExecutionValidation("call-validation", validate, () =>
        tool.execute("call-validation", { path: 47 }),
      ),
    ).rejects.toThrow("invalid projected arguments");

    expect(validate).toHaveBeenCalledWith({ path: 47 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("records structured replay trust only for concrete core-owned tools", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const coreTool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "search", execute }), {
      runId: "run-core",
    });
    const pluginSource = asAgentTool({ name: "search", execute });
    setPluginToolMeta(pluginSource, { pluginId: "example", optional: false });
    const pluginTool = wrapToolWithBeforeToolCallHook(pluginSource, {
      runId: "run-plugin",
    });

    const [coreDefinition] = toToolDefinitions([coreTool], { runId: "run-core" });
    const [pluginDefinition] = toToolDefinitions([pluginTool], { runId: "run-plugin" });
    const extensionContext = {} as ExtensionContext;
    await coreDefinition?.execute(
      "call-core",
      { query: "core" },
      undefined,
      undefined,
      extensionContext,
    );
    await pluginDefinition?.execute(
      "call-plugin",
      { query: "plugin" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(
      structuredReplaySafeToolCallIds.has(
        buildAdjustedParamsKey({
          runId: "run-core",
          toolCallId: "call-core",
        }),
      ),
    ).toBe(true);
    expect(
      structuredReplaySafeToolCallIds.has(
        buildAdjustedParamsKey({
          runId: "run-plugin",
          toolCallId: "call-plugin",
        }),
      ),
    ).toBe(false);
  });

  it("does not enter the tool body when a slow hook settles after cancellation", async () => {
    const { promise: hookGate, resolve: releaseHook } = createDeferred();
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        await hookGate;
        return { params: { mode: "late" } };
      },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const controller = new AbortController();
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }));
    const result = tool.execute("call-late-abort", { cmd: "pwd" }, controller.signal);
    await vi.waitFor(() => expect(beforeToolCallHook).toHaveBeenCalledOnce());
    expect(consumeTrackedToolExecutionStarted("call-late-abort")).toBe(false);

    controller.abort(new Error("tool timed out"));
    releaseHook();

    await expect(result).rejects.toThrow("tool timed out");
    expect(execute).not.toHaveBeenCalled();
    expect(consumeTrackedToolExecutionStarted("call-late-abort")).toBeUndefined();
    expect(consumePreExecutionBlockedToolCall("call-late-abort")).toBe(true);
  });

  it("does not execute lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockResolvedValue({ block: true, blockReason: "blocked-high" });
    const low = vi.fn().mockResolvedValue({ params: { shouldNotApply: true } });
    installBeforeToolCallHooks([
      { pluginId: "high", priority: 100, handler: high },
      { pluginId: "low", priority: 0, handler: low },
    ]);

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }));
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-stop", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).resolves.toEqual({
      content: [{ type: "text", text: "blocked-high" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked-high",
      },
    });

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks tool execution when hook throws", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        throw new Error("boom");
      },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }));
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-4", { path: "/tmp/file" }, undefined, extensionContext),
    ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes non-object params for hook contract", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "ReAd", execute }), {
      agentId: "main",
      sessionKey: "main",
      sessionId: "ephemeral-main",
      runId: "run-main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-5", "not-an-object", undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith("call-5", "not-an-object", undefined, extensionContext);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: {},
        runId: "run-main",
        toolCallId: "call-5",
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
        sessionId: "ephemeral-main",
        runId: "run-main",
        toolCallId: "call-5",
      },
    );
  });

  it("keeps adjusted params isolated per run when toolCallId collides", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: vi
        .fn()
        .mockResolvedValueOnce({ params: { marker: "A" } })
        .mockResolvedValueOnce({ params: { marker: "B" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const toolA = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "Read", execute }), {
      runId: "run-a",
    });
    const toolB = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "Read", execute }), {
      runId: "run-b",
    });
    const extensionContextA = {} as Parameters<typeof toolA.execute>[3];
    const extensionContextB = {} as Parameters<typeof toolB.execute>[3];
    const sharedToolCallId = "shared-call";

    await toolA.execute(sharedToolCallId, { path: "/tmp/a.txt" }, undefined, extensionContextA);
    await toolB.execute(sharedToolCallId, { path: "/tmp/b.txt" }, undefined, extensionContextB);

    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toEqual({
      path: "/tmp/a.txt",
      marker: "A",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-b")).toEqual({
      path: "/tmp/b.txt",
      marker: "B",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toBeUndefined();
  });
});

describe("before_tool_call hook deduplication (#15502)", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
  });

  it("preserves private execution semantics through both session tool adapters", async () => {
    const runId = "run-private-preparer-adapter";
    const source = wrapToolWithBeforeToolCallHook(
      asAgentTool({
        name: "search",
        execute: vi.fn().mockResolvedValue({ answer: 42 }),
      }),
      { runId },
    );
    const definition = expectDefined(
      toToolDefinitions([source], { runId })[0],
      "wrapped search tool definition",
    );
    const hydrated = wrapToolDefinition(definition);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(hydrated),
      "adapted private execution preparer",
    );
    const prepared = await preparer({
      toolCallId: "call-private-preparer-adapter",
      args: { query: "answer" },
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") {
      return;
    }
    const result = await prepared.execute();
    prepared.dispose();

    expect(result.details).toEqual({ answer: 42 });
    expect(
      structuredReplaySafeToolCallIds.has(
        buildAdjustedParamsKey({
          runId,
          toolCallId: "call-private-preparer-adapter",
        }),
      ),
    ).toBe(true);
  });

  it("preserves adapter error and abort handling for private execution", async () => {
    const failure = new Error("private execution failed");
    const failedSource = wrapToolWithBeforeToolCallHook(
      asAgentTool({ name: "read", execute: vi.fn().mockRejectedValue(failure) }),
    );
    const failedTool = wrapToolDefinition(
      expectDefined(toToolDefinitions([failedSource])[0], "failed private tool definition"),
    );
    const failedPreparer = expectDefined(
      getInternalToolExecutionPreparer(failedTool),
      "failed-tool private execution preparer",
    );
    const failedPrepared = await failedPreparer({ toolCallId: "call-failed", args: {} });
    expect(failedPrepared.kind).toBe("ready");
    if (failedPrepared.kind !== "ready") {
      return;
    }
    await expect(failedPrepared.execute()).resolves.toMatchObject({
      details: { status: "error", error: failure.message },
    });
    failedPrepared.dispose();

    const controller = new AbortController();
    const abortReason = new Error("private execution aborted");
    const abortedSource = wrapToolWithBeforeToolCallHook(
      asAgentTool({
        name: "read",
        execute: vi.fn(async (_id, _params, signal?: AbortSignal) => {
          signal?.throwIfAborted();
          return { content: [], details: { ok: true } };
        }),
      }),
    );
    const abortedTool = wrapToolDefinition(
      expectDefined(toToolDefinitions([abortedSource])[0], "aborted private tool definition"),
    );
    const abortedPreparer = expectDefined(
      getInternalToolExecutionPreparer(abortedTool),
      "aborted-tool private execution preparer",
    );
    const abortedPrepared = await abortedPreparer({
      toolCallId: "call-aborted",
      args: {},
      signal: controller.signal,
    });
    expect(abortedPrepared.kind).toBe("ready");
    if (abortedPrepared.kind !== "ready") {
      return;
    }
    const execution = abortedPrepared.execute();
    controller.abort(abortReason);
    await expect(execution).rejects.toBe(abortReason);
    abortedPrepared.dispose();
  });

  it("finalizes private policy outcomes before launch", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ block: true, blockReason: "blocked by policy" }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const source = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }));
    const tool = wrapToolDefinition(
      expectDefined(toToolDefinitions([source])[0], "policy-blocked private tool definition"),
    );
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(tool),
      "policy private execution preparer",
    );

    const prepared = await preparer({ toolCallId: "call-policy", args: {} });

    expect(prepared).toMatchObject({
      kind: "immediate",
      outcome: {
        kind: "result",
        isError: false,
        result: { details: { status: "blocked", reason: "blocked by policy" } },
      },
    });
    prepared.dispose();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["source", "adapter"] as const)(
    "commits final rewritten args immediately before private %s implementation",
    async (owner) => {
      beforeToolCallHook = installBeforeToolCallHook({
        runBeforeToolCallImpl: async () => ({ params: { value: "rewritten" } }),
      });
      const order: string[] = [];
      const execute = vi.fn(async () => {
        order.push("body");
        return { content: [], details: { ok: true } };
      });
      const base = asAgentTool({ name: "read", execute });
      const source = owner === "source" ? wrapToolWithBeforeToolCallHook(base) : base;
      const tool = wrapToolDefinition(
        expectDefined(toToolDefinitions([source])[0], "rewritten private tool definition"),
      );
      const preparer = expectDefined(
        getInternalToolExecutionPreparer(tool),
        "rewritten private execution preparer",
      );
      let closed = false;
      let prepared: Awaited<ReturnType<typeof preparer>> | undefined;
      const preparation = preparer({
        toolCallId: "call-rewritten",
        args: { value: "original" },
      }).then((value) => {
        prepared = value;
        if (closed) {
          value.dispose();
        }
        return value;
      });
      const pending: Promise<unknown>[] = [Promise.allSettled([preparation])];

      try {
        prepared = await withTestTimeout(preparation, 2_000, "private preparation did not finish");
        expect(prepared.kind).toBe("ready");
        expect(execute).not.toHaveBeenCalled();
        if (prepared.kind !== "ready") {
          return;
        }
        const onImplementationStart = vi.fn(() => {
          order.push("commit");
          queueMicrotask(() => order.push("gap"));
        });
        const execution = prepared.execute(onImplementationStart);
        pending.push(Promise.allSettled([execution]));
        await withTestTimeout(execution, 2_000, "private implementation did not finish");

        expect(prepared.args).toEqual({ value: "rewritten" });
        expect(onImplementationStart).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith(
          "call-rewritten",
          { value: "rewritten" },
          undefined,
          undefined,
        );
        expect(order).toEqual(["commit", "body", "gap"]);
      } finally {
        closed = true;
        try {
          prepared?.dispose();
        } finally {
          await withTestTimeout(Promise.all(pending), 2_000, "private cleanup did not settle");
        }
      }
    },
    10_000,
  );

  it("rechecks a private source guard after asynchronous before-tool policy", async () => {
    const { promise: held, resolve: releaseHook } = createDeferred();
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        await held;
      },
    });
    let authorityActive = true;
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const guarded = bindAgentToolSourceExecutionGuard(
      asAgentTool({ name: "read", execute }),
      () => {
        if (!authorityActive) {
          throw new Error("delegated authority closed");
        }
      },
    );
    const source = rewrapToolWithBeforeToolCallHook(guarded);

    const pending = expectDefined(source.execute, "guarded source execute")("call-guard", {});
    await vi.waitFor(() => expect(beforeToolCallHook).toHaveBeenCalledOnce());
    authorityActive = false;
    releaseHook();

    await expect(pending).rejects.toThrow("delegated authority closed");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["adapter", "client"] as const)(
    "suppresses the %s body after awaited hook preflight",
    async (kind) => {
      const { promise: hookStarted, resolve: markHookStarted } = createDeferred();
      const { promise: hookRelease, resolve: releaseHook } = createDeferred();
      beforeToolCallHook = installBeforeToolCallHook({
        runBeforeToolCallImpl: async () => {
          markHookStarted();
          await hookRelease;
          return undefined;
        },
      });
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const clientCall = vi.fn();
      const definition =
        kind === "adapter"
          ? expectDefined(
              toToolDefinitions([asAgentTool({ name: "read", execute })])[0],
              "unwrapped adapter definition",
            )
          : expectDefined(
              toClientToolDefinitions(
                [clientToolDefinition("client_read", "client read", {})],
                clientCall,
              )[0],
              "client adapter definition",
            );
      const preparer = expectDefined(
        getInternalToolExecutionPreparer(wrapToolDefinition(definition)),
        `${kind} private execution preparer`,
      );

      const preparing = preparer({ toolCallId: `${kind}-call`, args: {} });
      await hookStarted;
      releaseHook();
      const prepared = await preparing;
      expect(prepared.kind).toBe("ready");
      prepared.dispose();
      await Promise.resolve();

      expect(execute).not.toHaveBeenCalled();
      expect(clientCall).not.toHaveBeenCalled();
    },
  );

  it("finishes async reconciliation before exposing a wrapped call as ready", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { path: "/tmp/final" } }),
    });
    const runId = "run-reconcile-before-ready";
    const sessionKey = "agent:main:reconcile-before-ready";
    const state = getDiagnosticSessionState({ sessionKey, sessionId: "session-reconcile" });
    recordToolCall(state, "read", { path: "/tmp/original" }, "reconcile-call", { runId });
    const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
    const hookContext = {
      runId,
      sessionKey,
      sessionId: "session-reconcile",
      loopDetection: { enabled: true },
    };
    const source = wrapToolWithBeforeToolCallHook(
      asAgentTool({ name: "read", execute }),
      hookContext,
    );
    const tool = wrapToolDefinition(
      expectDefined(toToolDefinitions([source], hookContext)[0], "reconcile tool definition"),
    );
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(tool),
      "reconcile private execution preparer",
    );

    const prepared = await preparer({
      toolCallId: "reconcile-call",
      args: { path: "/tmp/original" },
    });

    expect(prepared.kind).toBe("ready");
    expect(state.toolCallHistory?.at(-1)?.argsHash).toBe(
      hashToolCall("read", { path: "/tmp/final" }),
    );
    prepared.dispose();
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes agent context to outer code-mode exec hooks through OpenClaw custom tools", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked before code-mode execution",
      }),
    });
    const abortController = new AbortController();
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: abortController.signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const execTool = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!execTool) {
      throw new Error("missing code-mode exec tool");
    }
    const customTools = toToolDefinitions(
      [execTool],
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      },
      undefined,
    );
    const [def] = customTools;
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    for (const { toolCallId, input, expectedParams, metadata } of [
      {
        toolCallId: "call-code-mode-exec",
        input: { code: "return 1;" },
        expectedParams: { code: "return 1;", command: "return 1;" },
        metadata: { toolInputKind: "javascript" },
      },
      {
        toolCallId: "call-code-mode-exec-command",
        input: { command: "return 2;" },
        expectedParams: { code: "return 2;", command: "return 2;" },
        metadata: { toolInputKind: "javascript" },
      },
      {
        toolCallId: "call-code-mode-exec-blank-code",
        input: { code: "", command: "return 3;" },
        expectedParams: { code: "return 3;", command: "return 3;" },
        metadata: { toolInputKind: "javascript" },
      },
      {
        toolCallId: "call-code-mode-exec-typescript",
        input: { code: "const value: number = 5;", language: "typescript" },
        expectedParams: {
          code: "const value: number = 5;",
          command: "const value: number = 5;",
          language: "typescript",
        },
        metadata: {},
      },
      {
        toolCallId: "call-code-mode-exec-null-command",
        input: { code: "return 4;", command: null },
        expectedParams: { code: "return 4;", command: "return 4;" },
        metadata: { toolInputKind: "javascript" },
      },
    ]) {
      beforeToolCallHook.mockClear();
      const result = await def.execute(toolCallId, input, undefined, undefined, extensionContext);

      expect(result.details).toMatchObject({
        status: "blocked",
        reason: "blocked before code-mode execution",
      });
      expect(beforeToolCallHook).toHaveBeenCalledWith(
        {
          toolName: "exec",
          params: expectedParams,
          toolKind: "code_mode_exec",
          ...metadata,
          runId: "run-main",
          toolCallId,
        },
        {
          toolName: "exec",
          toolKind: "code_mode_exec",
          ...metadata,
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId,
        },
      );
    }
  });

  it("normalizes outer code-mode exec hook params when a wrapper owns the hook", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked before code-mode execution",
      }),
    });
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: new AbortController().signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const execTool = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!execTool) {
      throw new Error("missing code-mode exec tool");
    }
    const abortSignal = new AbortController().signal;
    const wrapped = wrapToolWithAbortSignal(
      wrapToolWithBeforeToolCallHook(execTool, {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      }),
      abortSignal,
    );
    const [def] = toToolDefinitions([wrapped]);
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    const result = await def.execute(
      "call-wrapped-code-mode-exec",
      { command: "return 3;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { command: "return 3;", code: "return 3;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-wrapped-code-mode-exec",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        abortSignal,
        toolCallId: "call-wrapped-code-mode-exec",
      },
    );
  });

  it.each([
    { alias: "command", replacement: null },
    { alias: "code", replacement: "return 3;" },
    { alias: "command", replacement: "return 3;" },
  ])(
    "handles a hook after a trusted rewrite changing the $alias code-mode exec alias to $replacement",
    async ({ alias, replacement }) => {
      resetGlobalHookRunner();
      const registry = createEmptyPluginRegistry();
      registry.trustedToolPolicies = [
        {
          pluginId: "trusted-plugin",
          pluginName: "Trusted Plugin",
          source: "test",
          policy: {
            id: "code-mode-rewrite-policy",
            description: "rewrite both code-mode exec aliases",
            evaluate: () => ({ params: { code: "return 2;", command: "return 2;" } }),
          },
        },
      ];
      addTestHook({
        registry,
        pluginId: "normal-plugin",
        hookName: "before_tool_call",
        handler: (async () => ({
          params: { [alias]: replacement },
        })) as PluginHookRegistration["handler"],
      });
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      try {
        const codeModeConfig: OpenClawConfig = { tools: { codeMode: true } };
        const catalogRef = createToolSearchCatalogRef();
        registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
        const execTool = createCodeModeTools({
          config: codeModeConfig,
          runtimeConfig: codeModeConfig,
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          abortSignal: new AbortController().signal,
          catalogRef,
          executeTool: async () => {
            throw new Error("catalog tool execution should not be reached");
          },
        }).find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
        if (!execTool) {
          throw new Error("missing code-mode exec tool");
        }
        const [def] = toToolDefinitions(
          [execTool],
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionId: "session-main",
            runId: "run-main",
          },
          undefined,
        );
        if (!def) {
          throw new Error("missing custom tool definition");
        }

        const result = await def.execute(
          `call-code-mode-${alias}-${replacement === "return 3;" ? "rewrite" : "invalidate"}`,
          { code: "return 1;", command: "return 1;" },
          undefined,
          undefined,
          {} as Parameters<typeof def.execute>[4],
        );

        if (replacement === "return 3;") {
          expect(result.details, JSON.stringify(result.details)).toMatchObject({
            status: "completed",
            value: 3,
          });
        } else {
          expect(result.details).toEqual({
            status: "error",
            tool: "exec",
            error: "code or command must be a non-empty string.",
          });
        }
      } finally {
        setActivePluginRegistry(createEmptyPluginRegistry());
        resetGlobalHookRunner();
      }
    },
  );

  it("isolates terminal presentation arguments while using the final middleware result", async () => {
    const onToolOutcome = vi.fn();
    const execute = vi.fn(async (_id: string, params: { request: { url: string } }) => {
      params.request.url = "https://executed.example";
      return { content: [], details: { status: 200 } };
    });
    const sourceTool = setToolTerminalPresentation(
      asAgentTool({
        name: "web_fetch",
        description: "fetch",
        parameters: {},
        resultContentSource: "network",
        execute,
      }),
      (params, result) => {
        const url = (params as { request: { url: string } }).request.url;
        return {
          text: `Fetched ${url} with status ${(result.details as { status: number }).status}`,
        };
      },
    );
    const tool = expectDefined(
      finalizeAgentTools({
        tools: [sourceTool],
        modelProvider: "openai",
        hookContext: {
          sessionId: "session-terminal-presentation",
          runId: "run-terminal-presentation",
          onToolOutcome,
        },
      })[0],
      "wrapped finalized source tool",
    );
    await tool.execute("call-terminal-presentation", {
      request: { url: "https://example.com" },
    });

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_fetch",
        resultContentSource: "network",
        terminalPresentation: "Fetched https://executed.example with status 200",
      }),
    );

    expectDefined(execute.mock.calls[0], "executed formatter arguments")[1].request.url =
      "https://changed.example";
    finalizeToolTerminalPresentation({
      toolCallId: "call-terminal-presentation",
      runId: "run-terminal-presentation",
      result: { content: [], details: { status: 201 } },
      isError: false,
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: "Fetched https://executed.example with status 201",
      }),
    );
  });

  it("does not publish terminal presentation state when raw outcome observation fails", async () => {
    const observerError = new Error("observer failed");
    const onToolOutcome = vi.fn(() => {
      throw observerError;
    });
    const tool = wrapToolWithBeforeToolCallHook(
      asAgentTool({
        name: "read_file",
        description: "read",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ content: [], details: { ok: true } }),
      }),
      {
        sessionId: "session-terminal-observer-error",
        runId: "run-terminal-observer-error",
        onToolOutcome,
      },
    );

    await expect(tool.execute("call-terminal-observer-error", {})).rejects.toBe(observerError);
    const callsBeforeFinalization = onToolOutcome.mock.calls.length;
    expect(() =>
      finalizeToolTerminalPresentation({
        toolCallId: "call-terminal-observer-error",
        runId: "run-terminal-observer-error",
        result: { content: [], details: { ok: true } },
        isError: false,
      }),
    ).not.toThrow();
    expect(onToolOutcome).toHaveBeenCalledTimes(callsBeforeFinalization);
  });

  it("clears a prior summary for large uncloneable plain-tool input and fences stale finalizers", async () => {
    type ToolResult = { content: []; details: { ok?: boolean; status?: number } };
    const presentationExecution = createDeferred<ToolResult>();
    const plainExecution = createDeferred<ToolResult>();
    let terminalPresentation: string | undefined = "Previous tool summary";
    let latestOrdinal = -1;
    const onToolOutcome = vi.fn(
      (outcome: { toolCallOrdinal?: number; terminalPresentation?: string }) => {
        const ordinal = outcome.toolCallOrdinal ?? latestOrdinal + 1;
        if (ordinal >= latestOrdinal) {
          latestOrdinal = ordinal;
          terminalPresentation = outcome.terminalPresentation;
        }
      },
    );
    let nextToolOutcomeOrdinal = 0;
    const hookContext = {
      runId: "run-parallel-terminal-presentation",
      sessionId: "session-parallel-terminal-presentation",
      onToolOutcome,
      allocateToolOutcomeOrdinal: () => nextToolOutcomeOrdinal++,
    };
    const presentationTool = wrapToolWithBeforeToolCallHook(
      setToolTerminalPresentation(
        asAgentTool({
          name: "web_fetch",
          description: "fetch",
          parameters: {},
          execute: vi.fn(() => presentationExecution.promise),
        }),
        () => ({ text: "Fetched with status 200" }),
      ),
      hookContext,
    );
    const plainTool = wrapToolWithBeforeToolCallHook(
      {
        ...asAgentTool({
          name: "read_file",
          description: "read",
          parameters: {},
          execute: vi.fn(() => plainExecution.promise),
        }),
        // Tool-owned preparation can carry private, non-JSON execution state.
        finalizeBeforeToolCallParams: () => ({
          content: Array.from({ length: 16_384 }, (_, index) => index),
          privateCallback: () => undefined,
        }),
      },
      hookContext,
    );

    const presentationResultPromise = presentationTool.execute("call-presentation", {});
    const plainResultPromise = plainTool.execute("call-plain", {});

    plainExecution.resolve({ content: [], details: { ok: true } });
    const plainResult = await plainResultPromise;
    finalizeToolTerminalPresentation({
      toolCallId: "call-plain",
      runId: hookContext.runId,
      result: plainResult,
      isError: false,
    });
    expect(terminalPresentation).toBeUndefined();

    presentationExecution.resolve({ content: [], details: { status: 200 } });
    const presentationResult = await presentationResultPromise;
    finalizeToolTerminalPresentation({
      toolCallId: "call-presentation",
      runId: hookContext.runId,
      result: presentationResult,
      isError: false,
    });

    expect(terminalPresentation).toBeUndefined();
    expect(onToolOutcome.mock.calls.map(([outcome]) => outcome.toolCallOrdinal)).toEqual([
      1, 1, 0, 0,
    ]);
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolCallOrdinal: 0,
        terminalPresentation: "Fetched with status 200",
      }),
    );
  });

  it("passes hook context for unwrapped tool definitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = asAgentTool({ name: "exec", execute, description: "exec", parameters: {} });
    const def = expectDefined(
      toToolDefinitions([baseTool], {
        agentId: "code-agent",
        sessionKey: "agent:code-agent:main",
        sessionId: "session-code",
        runId: "run-code",
        channelId: "channel-code",
      })[0],
      "unwrapped exec definition",
    );
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-code-exec",
      { code: "echo hi" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "echo hi" },
        runId: "run-code",
        toolCallId: "call-code-exec",
      },
      {
        toolName: "exec",
        agentId: "code-agent",
        sessionKey: "agent:code-agent:main",
        sessionId: "session-code",
        runId: "run-code",
        toolCallId: "call-code-exec",
        channelId: "channel-code",
      },
    );
  });
});

describe("before_tool_call adapter and client tool integration", () => {
  function installAbortBlockingHook() {
    const { promise: started, resolve: markStarted } = createDeferred();
    let observedAbort = false;
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async (_event, ctx) => {
        const signal = (ctx as { abortSignal?: AbortSignal }).abortSignal;
        markStarted();
        if (signal) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              observedAbort = true;
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
        }
        return { block: true, blockReason: "cancelled by owning tool call" };
      },
    });
    return {
      started,
      didObserveAbort: () => observedAbort,
    };
  }

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    installBeforeToolCallHook();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it("cancels before-tool hook work through the adapter path", async () => {
    const controller = new AbortController();
    const hook = installAbortBlockingHook();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = asAgentTool({ name: "read", execute });
    const definition = expectDefined(toToolDefinitions([tool])[0], "adapter tool definition");

    const execution = definition.execute(
      "call-signal-adapter",
      { path: "/tmp/input" },
      controller.signal,
      undefined,
      {} as ExtensionContext,
    );
    await hook.started;
    controller.abort(new Error("cancel test"));
    await execution;

    expect(hook.didObserveAbort()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels client-tool hook work and releases its reservation", async () => {
    const controller = new AbortController();
    const hook = installAbortBlockingHook();
    const recorder = {
      reserve: vi.fn(),
      complete: vi.fn(),
      discard: vi.fn(),
    };
    const tool = expectDefined(
      toClientToolDefinitions(
        [clientToolDefinition("client_tool", "Client tool", {})],
        recorder,
      )[0],
      "client tool definition",
    );

    const execution = tool.execute(
      "client-call-signal",
      {},
      controller.signal,
      undefined,
      {} as ExtensionContext,
    );
    await hook.started;
    controller.abort(new Error("cancel test"));
    await execution;

    expect(hook.didObserveAbort()).toBe(true);
    expect(recorder.reserve).toHaveBeenCalledWith("client-call-signal", "client_tool");
    expect(recorder.discard).toHaveBeenCalledWith("client-call-signal", "client_tool");
    expect(recorder.complete).not.toHaveBeenCalled();
  });

  it("passes modified params to client tool callbacks", async () => {
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { extra: true } }),
    });
    const onClientToolCall = vi.fn();
    const clientTools = toClientToolDefinitions(
      [clientToolDefinition("client_tool", "Client tool", { value: { type: "string" } })],
      onClientToolCall,
      { agentId: "main", sessionKey: "main" },
    );
    const tool = expectDefined(clientTools[0], "client tool definition");
    const extensionContext = {} as Parameters<typeof tool.execute>[4];
    await tool.execute("client-call-1", { value: "ok" }, undefined, undefined, extensionContext);

    expect(onClientToolCall).toHaveBeenCalledWith("client_tool", {
      value: "ok",
      extra: true,
    });
  });

  it("preserves client tool source order when hooks resolve out of order", async () => {
    const { promise: firstHookGate, resolve: releaseFirstHook } = createDeferred();
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async (event: unknown) => {
        const toolName = (event as { toolName?: string }).toolName;
        if (toolName === "first_tool") {
          await firstHookGate;
        }
        return { params: { marker: toolName } };
      },
    });

    const slots: Array<{
      toolCallId: string;
      name: string;
      params?: Record<string, unknown>;
      completed: boolean;
    }> = [];
    const indexes = new Map<string, number>();
    const reserve = (toolCallId: string, name: string) => {
      indexes.set(toolCallId, slots.length);
      slots.push({ toolCallId, name, completed: false });
    };
    const complete = (toolCallId: string, name: string, params: Record<string, unknown>) => {
      const index = indexes.get(toolCallId);
      if (index === undefined) {
        throw new Error(`missing reserved client tool slot for ${toolCallId}`);
      }
      const slot = slots[index];
      if (!slot) {
        throw new Error(`missing client tool slot at ${index}`);
      }
      slot.name = name;
      slot.params = params;
      slot.completed = true;
    };
    const [firstTool, secondTool] = toClientToolDefinitions(
      [
        clientToolDefinition("first_tool", "First client tool", { value: { type: "string" } }),
        clientToolDefinition("second_tool", "Second client tool", { value: { type: "string" } }),
      ],
      { reserve, complete },
      { agentId: "main", sessionKey: "main" },
    );
    if (!firstTool || !secondTool) {
      throw new Error("missing client tool definitions");
    }
    const extensionContext = {} as Parameters<typeof firstTool.execute>[4];

    const firstRun = firstTool.execute(
      "client-call-1",
      { value: "first" },
      undefined,
      undefined,
      extensionContext,
    );
    const secondRun = secondTool.execute(
      "client-call-2",
      { value: "second" },
      undefined,
      undefined,
      extensionContext,
    );

    await secondRun;
    expect(slots.map((slot) => ({ name: slot.name, completed: slot.completed }))).toEqual([
      { name: "first_tool", completed: false },
      { name: "second_tool", completed: true },
    ]);

    releaseFirstHook();
    await firstRun;

    expect(
      collectMatching(
        slots,
        (slot) => slot.completed,
        (slot) => slot.name,
      ),
    ).toEqual(["first_tool", "second_tool"]);
    expect(slots.map((slot) => slot.params)).toEqual([
      { value: "first", marker: "first_tool" },
      { value: "second", marker: "second_tool" },
    ]);
  });

  it("lets trusted policies read session extensions for client tools when config is provided", async () => {
    resetGlobalHookRunner();
    const stateDir = sessionDirs.make();
    const storePath = path.join(stateDir, "sessions.json");
    const config = { session: { store: storePath } };
    const seen: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.sessionExtensions = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        extension: {
          namespace: "policy",
          description: "policy state",
        },
      },
    ];
    registry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "client-tool-session-extension-policy",
          description: "client tool session extension policy",
          evaluate(eventValue, ctx) {
            seen.push(ctx.getSessionExtension?.("policy"));
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    try {
      await replaceSessionEntry({ sessionKey: "agent:main:client", storePath }, {
        sessionId: "session-client",
        updatedAt: Date.now(),
      } as SessionEntry);
      await expect(
        patchPluginSessionExtension({
          cfg: config as never,
          sessionKey: "agent:main:client",
          pluginId: "policy-plugin",
          namespace: "policy",
          value: { gate: "client" },
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:client",
        value: { gate: "client" },
      });

      const clientTools = toClientToolDefinitions(
        [clientToolDefinition("client_tool", "Client tool", {})],
        undefined,
        {
          agentId: "main",
          sessionKey: "agent:main:client",
          sessionId: "session-client",
          config: config as never,
        },
      );
      const tool = expectDefined(clientTools[0], "client tool definition");
      const extensionContext = {} as Parameters<typeof tool.execute>[4];
      await tool.execute("client-call-policy", {}, undefined, undefined, extensionContext);

      expect(seen).toEqual([{ gate: "client" }]);
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
