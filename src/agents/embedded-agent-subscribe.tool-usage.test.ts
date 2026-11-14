import { describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import { createSubscribedToolSearchExecutor } from "./embedded-agent-runner/run/attempt-tool-search-executor.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { markToolExecutionNotStarted } from "./tool-effect-receipt.js";
import {
  applyToolCatalogCompaction,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { bindToolUsageIds } from "./tool-usage-bindings.js";
import type { RunToolUsageRecorder } from "./tool-usage-recorder.js";

function recordingSink() {
  return {
    record: vi.fn(),
    bindTranscript: vi.fn(),
    takeAppend: vi.fn(),
    committed: vi.fn(),
    settle: vi.fn(async () => {}),
  } satisfies RunToolUsageRecorder;
}

function mcpTool(server: string, name: string, details: Record<string, unknown> = {}) {
  const result = {
    ...createStubTool(name),
    execute: async () => ({ content: [], details: { mcpServer: server, ...details } }),
  };
  setPluginToolMeta(result, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: { serverName: server, safeServerName: server, toolName: name, operation: "tool" },
  });
  return result;
}

function tool(name: string, pluginId?: string) {
  const result = {
    ...createStubTool(name),
    execute: async () => ({ content: [], details: { ok: true } }),
  };
  if (pluginId) {
    setPluginToolMeta(result, { pluginId, optional: false });
  }
  return result;
}

describe("usage at the embedded completion boundary", () => {
  it("counts exact direct and nested targets, never dispatch or Code Mode wrappers", async () => {
    const target = tool("lookup", "notes");
    const dispatch = tool("dispatch_action");
    const shell = tool("exec");
    const remoteLookalike = tool("lookup", "bundle-mcp");
    const codeMode = markCodeModeControlTool(tool("exec"));
    const recorder = recordingSink();
    const toolUsageIdsByName = bindToolUsageIds([target, dispatch, codeMode], []);
    const manager = SessionManager.inMemory();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "usage-targets",
      agentId: "main",
      toolUsageRecorder: recorder,
      toolUsageIdsByName,
      codeModeExecToolNames: new Set(["exec"]),
      sessionExtras: { sessionManager: manager },
    });
    const catalogRef = createToolSearchCatalogRef();
    applyToolCatalogCompaction({
      tools: [dispatch, target, shell, remoteLookalike],
      enabled: true,
      catalogRef,
      isVisibleControlTool: (candidate) => candidate === dispatch,
    });
    const runtime = new ToolSearchRuntime(
      {
        catalogRef,
        executeTool: createSubscribedToolSearchExecutor({
          attempt: { runId: "usage-targets" },
          runSignal: new AbortController().signal,
          sessionManager: manager,
          subscription,
          isCurrent: () => true,
          isReplaySafeTool: () => true,
          nestedToolActivityState: { scopeId: "usage", successfulToolNames: new Set() },
        }),
      },
      resolveToolSearchConfig({ tools: { toolSearch: true } }),
    );
    const direct = async (toolName: string, toolCallId: string) => {
      emit({ type: "tool_execution_start", toolName, toolCallId, args: {} });
      emit({
        type: "tool_execution_end",
        toolName,
        toolCallId,
        executionStarted: true,
        isError: false,
        result: { content: [], details: { ok: true } },
      });
      await subscription.waitForPendingEvents();
    };
    try {
      await direct("lookup", "direct-lookup");
      await runtime.call("openclaw:notes:lookup", {}, { parentToolCallId: "dispatch" });
      await direct("dispatch_action", "dispatch");
      await runtime.call("openclaw:core:exec", {}, { parentToolCallId: "code-mode" });
      await direct("exec", "code-mode");
      await runtime.call("mcp:bundle-mcp:lookup", {}, { parentToolCallId: "remote" });
      // The same-named MCP lookalike counts under its own exact identity.
      expect(recorder.record.mock.calls).toEqual([
        ["openclaw:notes:lookup"],
        ["openclaw:notes:lookup"],
        ["openclaw:core:exec"],
        ["mcp:bundle-mcp:lookup"],
      ]);
      emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
      await subscription.waitForPendingEvents();
      expect(recorder.takeAppend).not.toHaveBeenCalled();
      expect(recorder.settle).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
      clearToolSearchCatalog({ catalogRef });
    }
  });

  it("records only successful implementations, including private no-start refusals", async () => {
    const recorder = recordingSink();
    const { ctx } = createTestContext();
    ctx.params.toolUsageRecorder = recorder;
    ctx.params.toolUsageIdsByName = new Map([["lookup", "openclaw:notes:lookup"]]);
    const excluded = [
      { executionStarted: undefined },
      { executionStarted: false },
      { isError: true },
      ...["pending", "approval-pending", "waiting", "skipped", "cancelled", "failed"].map(
        (status) => ({ result: { details: { status } } }),
      ),
      { result: markToolExecutionNotStarted({ details: { ok: true } }) },
    ];
    for (const [index, overrides] of excluded.entries()) {
      const call = { toolName: "lookup", toolCallId: `excluded-${index}` };
      await handleToolExecutionStart(ctx, { type: "tool_execution_start", ...call, args: {} });
      await endTool(ctx, {
        ...call,
        executionStarted: true,
        result: { details: { ok: true } },
        ...overrides,
      });
    }
    expect(recorder.record).not.toHaveBeenCalled();
    const call = { toolName: "lookup", toolCallId: "successful" };
    await handleToolExecutionStart(ctx, { type: "tool_execution_start", ...call, args: {} });
    // A permission refresh cannot reattribute an already-started call to its replacement.
    ctx.params.toolUsageIdsByName = new Map([["lookup", "openclaw:replacement:lookup"]]);
    await endTool(ctx, { ...call, executionStarted: true, result: { details: { ok: true } } });
    expect(recorder.record.mock.calls).toEqual([["openclaw:notes:lookup"]]);
  });

  it("binds exact MCP identities but never client or ambiguous bare-name ownership", () => {
    const bindings = bindToolUsageIds(
      [
        tool("lookup", "first"),
        tool("lookup", "second"),
        tool("client_shadow", "notes"),
        mcpTool("granola", "granola__list_meetings"),
        mcpTool("granola", "shared"),
        tool("shared", "notes"),
        mcpTool("granola", "granola__client_app"),
        tool("read"),
      ],
      ["client_shadow", "granola__client_app"],
    );
    expect([...bindings]).toEqual([
      ["granola__list_meetings", "mcp:granola:granola__list_meetings"],
      ["read", "openclaw:core:read"],
    ]);
  });

  it("counts successful direct, dispatched, and Code Mode MCP calls by catalog id", async () => {
    const meetings = mcpTool("granola", "granola__list_meetings");
    const failing = mcpTool("granola", "granola__get_transcript", { status: "error" });
    const dispatch = tool("dispatch_action");
    const codeMode = markCodeModeControlTool(tool("exec"));
    const recorder = recordingSink();
    const manager = SessionManager.inMemory();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "mcp-usage",
      agentId: "main",
      toolUsageRecorder: recorder,
      toolUsageIdsByName: bindToolUsageIds([meetings, dispatch, codeMode], []),
      codeModeExecToolNames: new Set(["exec"]),
      sessionExtras: { sessionManager: manager },
    });
    const catalogRef = createToolSearchCatalogRef();
    applyToolCatalogCompaction({
      tools: [dispatch, meetings, failing],
      enabled: true,
      catalogRef,
      isVisibleControlTool: (candidate) => candidate === dispatch,
    });
    const runtime = new ToolSearchRuntime(
      {
        catalogRef,
        executeTool: createSubscribedToolSearchExecutor({
          attempt: { runId: "mcp-usage" },
          runSignal: new AbortController().signal,
          sessionManager: manager,
          subscription,
          isCurrent: () => true,
          isReplaySafeTool: () => true,
          nestedToolActivityState: { scopeId: "mcp-usage", successfulToolNames: new Set() },
        }),
      },
      resolveToolSearchConfig({ tools: { toolSearch: true } }),
    );
    const direct = async (toolName: string, toolCallId: string) => {
      emit({ type: "tool_execution_start", toolName, toolCallId, args: {} });
      emit({
        type: "tool_execution_end",
        toolName,
        toolCallId,
        executionStarted: true,
        isError: false,
        result: { content: [], details: { mcpServer: "granola" } },
      });
      await subscription.waitForPendingEvents();
    };
    try {
      await direct("granola__list_meetings", "direct-mcp");
      await runtime.call("granola__list_meetings", {}, { parentToolCallId: "dispatch" });
      await direct("dispatch_action", "dispatch");
      await runtime.call(
        "mcp:granola:granola__list_meetings",
        {},
        {
          parentToolCallId: "code-mode",
        },
      );
      await runtime.call(
        "mcp:granola:granola__get_transcript",
        {},
        {
          parentToolCallId: "code-mode",
        },
      );
      await direct("exec", "code-mode");
      expect(recorder.record.mock.calls).toEqual([
        ["mcp:granola:granola__list_meetings"],
        ["mcp:granola:granola__list_meetings"],
        ["mcp:granola:granola__list_meetings"],
      ]);
    } finally {
      subscription.unsubscribe();
      clearToolSearchCatalog({ catalogRef });
    }
  });
});
