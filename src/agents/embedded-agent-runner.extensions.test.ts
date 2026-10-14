import assert from "node:assert/strict";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createTerminalPresentationContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  AuthStorage,
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  loadExtensionFromFactory,
  ModelRegistry,
  SessionManager,
} from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
} from "../plugins/agent-tool-result-middleware-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  consumeAdjustedParamsForToolCall,
  recordAdjustedParamsForToolCall,
} from "./agent-tools.before-tool-call.js";
import { buildEmbeddedExtensionFactories } from "./embedded-agent-runner/extensions.js";
import { consumeEmbeddedToolReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import { cleanupTempPluginTestEnvironment } from "./test-helpers/temp-plugin-extension-fixtures.js";
import { jsonResult } from "./tools/common.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempPluginTestEnvironment(tempDirs, originalBundledPluginsDir);
});

function installMiddleware(handler: AgentToolResultMiddleware) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test",
    pluginName: "test",
    rawHandler: handler,
    handler,
    runtimes: ["openclaw"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}

type FactoryOverrides = Partial<Parameters<typeof buildEmbeddedExtensionFactories>[0]>;
function createFactory(overrides: FactoryOverrides = {}) {
  return buildEmbeddedExtensionFactories({
    cfg: undefined,
    workspaceDir: "/workspace",
    sessionManager: overrides.sessionManager ?? SessionManager.inMemory(),
    model: undefined,
    ...overrides,
  })[0];
}

async function createToolResultRunner(overrides: FactoryOverrides = {}) {
  const sessionManager = SessionManager.inMemory();
  const factory = createFactory({ sessionManager, ...overrides });
  assert(factory, "Expected embedded tool-result extension factory");
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    factory,
    "/tmp",
    createEventBus(),
    runtime,
    "<embedded-test>",
  );
  return new ExtensionRunner(
    [extension],
    runtime,
    "/tmp",
    sessionManager,
    ModelRegistry.inMemory(AuthStorage.inMemory()),
  );
}

async function createToolResultHandler(overrides: FactoryOverrides = {}) {
  const factory = createFactory(overrides);
  const handlers = new Map<string, Function>();
  await factory?.({
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
  } as never);
  return (event: unknown) => handlers.get("tool_result")?.(event, { cwd: "/tmp" });
}

async function createTerminalRun(
  suffix: string,
  format: Parameters<typeof createTerminalPresentationContractTool>[0]["format"],
) {
  const runId = `run-terminal-${suffix}`;
  const toolCallId = `call-terminal-${suffix}`;
  const input = { url: "https://private.example" };
  const onToolOutcome = vi.fn();
  const tool = wrapToolWithBeforeToolCallHook(
    createTerminalPresentationContractTool({
      name: "web_fetch",
      result: textToolResult("raw output", { origin: "private.example", status: 200 }),
      format,
    }),
    { runId, sessionId: `session-terminal-${suffix}`, onToolOutcome },
  );
  const rawResult = await tool.execute(toolCallId, input, undefined, undefined);
  const handler = await createToolResultHandler({ runId });
  return {
    runId,
    toolCallId,
    onToolOutcome,
    emit: () =>
      handler({
        toolName: "web_fetch",
        toolCallId,
        input: { url: "https://private.example" },
        content: rawResult.content,
        details: rawResult.details,
      }),
  };
}

describe("buildEmbeddedExtensionFactories", () => {
  it("passes the prepared run identity to installed result middleware", async () => {
    const identity = {
      agentId: "main",
      sessionId: "session-normal",
      sessionKey: "agent:main:discord:channel:normal",
      runId: "run-normal",
    };
    const middleware = vi.fn(
      (event: AgentToolResultMiddlewareEvent, _context: AgentToolResultMiddlewareContext) => ({
        result: {
          ...textToolResult("middleware-observed", { observedTool: event.toolName }),
          terminate: true,
        },
      }),
    );
    installMiddleware(middleware);

    const runner = await createToolResultRunner(identity);
    const result = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: `${identity.runId}-read`,
      input: { path: "README.md" },
      ...textToolResult("original tool output", {}),
      isError: false,
    });

    expect(middleware).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: "read",
        toolCallId: `${identity.runId}-read`,
        args: { path: "README.md" },
      }),
      { runtime: "openclaw", ...identity },
    );
    expect(result).toMatchObject({
      ...textToolResult("middleware-observed", { observedTool: "read" }),
      terminate: true,
    });
  });

  it("bridges middleware mutations with unique fallback tool call ids", async () => {
    const seenToolCallIds: string[] = [];
    installMiddleware((event) => {
      seenToolCallIds.push(event.toolCallId);
      event.result.content = textToolResult(`compacted ${seenToolCallIds.length}`, {}).content;
      return undefined;
    });

    const handler = await createToolResultHandler();

    const first = await handler?.({
      toolName: "exec",
      ...textToolResult("raw 1", {}),
    });
    const second = await handler?.({
      toolName: "exec",
      ...textToolResult("raw 2", {}),
    });

    expect(first).toEqual(textToolResult("compacted 1", {}));
    expect(second).toEqual(textToolResult("compacted 2", {}));
    expect(seenToolCallIds).toHaveLength(2);
    expect(seenToolCallIds[0]).toMatch(/^openclaw-/);
    expect(seenToolCallIds[1]).toMatch(/^openclaw-/);
    expect(seenToolCallIds[0]).not.toBe(seenToolCallIds[1]);
  });

  it("finalizes terminal presentation from the post-middleware result", async () => {
    const seenMiddlewareArgs: unknown[] = [];
    installMiddleware((event) => {
      seenMiddlewareArgs.push(structuredClone(event.args));
      (event.args as { url?: string }).url = "https://mutated.example";
      return {
        result: textToolResult("redacted output", {
          origin: "redacted.example",
          status: 200,
        }),
      };
    });
    const terminal = await createTerminalRun("middleware", (params, result) => {
      const input = params as { url?: string };
      const details = result.details as { origin?: string; status?: number };
      return `URL: ${String(input.url)}\nOrigin: ${String(details.origin)}\nStatus: ${String(details.status)}`;
    });
    recordAdjustedParamsForToolCall(
      terminal.toolCallId,
      { url: "https://approved.example" },
      terminal.runId,
    );
    await terminal.emit();

    expect(terminal.onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: "URL: https://private.example\nOrigin: redacted.example\nStatus: 200",
      }),
    );
    expect(seenMiddlewareArgs).toEqual([{ url: "https://approved.example" }]);
    expect(
      consumeAdjustedParamsForToolCall("call-terminal-middleware", "run-terminal-middleware"),
    ).toEqual({ url: "https://approved.example" });
  });

  it("clears terminal presentation when middleware blocks the result", async () => {
    installMiddleware(() => ({
      result: textToolResult("blocked by middleware", {
        status: "blocked",
        reason: "policy denied",
      }),
    }));
    const terminal = await createTerminalRun("blocked", () => "Origin: private.example");
    const result = await terminal.emit();

    expect(result).toMatchObject({ isError: true });
    expect(terminal.onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: undefined,
      }),
    );
  });

  it("stores private send receipts without overriding middleware details", async () => {
    installMiddleware((event) => ({
      result: {
        content: event.result.content,
        details: { redacted: true },
      },
    }));

    const receipt = {
      toolSend: { to: "channel:resolved-id", threadId: "root-1" },
      messageDelivery: {
        status: "settled",
        primaryPlatformMessageId: "message-1",
        partialDelivery: false,
        createdThreadIds: ["root-1"],
      },
    };
    const sessionManager = SessionManager.inMemory();
    const handler = await createToolResultHandler({ sessionManager });

    const result = await handler?.({
      toolName: "message",
      toolCallId: "call-message",
      content: [{ type: "text", text: "Sent." }],
      details: structuredClone(receipt),
    });

    expect(result).toEqual(textToolResult("Sent.", { redacted: true }));
    expect(consumeEmbeddedToolReceipt(sessionManager, "call-message")).toEqual({
      details: receipt,
    });
    expect(consumeEmbeddedToolReceipt(sessionManager, "call-message")).toBeUndefined();
  });

  it("keeps a confirmed send successful when result middleware fails", async () => {
    installMiddleware(() => {
      throw new Error("redaction failed");
    });

    const receipt = {
      toolSend: { to: "channel:C123" },
      messageDelivery: {
        status: "settled",
        primaryPlatformMessageId: "1700000000.000100",
        partialDelivery: false,
        createdThreadIds: [],
      },
    };
    const sessionManager = SessionManager.inMemory();
    const handler = await createToolResultHandler({ sessionManager });

    const result = await handler?.({
      toolName: "message",
      toolCallId: "call-message",
      input: { action: "send", target: "C123" },
      content: [{ type: "text", text: "raw result must stay private" }],
      details: {
        ok: true,
        result: { messageId: "1700000000.000100", channelId: "C123" },
        ...structuredClone(receipt),
      },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
      details: {
        ok: true,
        deliveryStatus: "sent",
        middlewareWarning: "post-processing failed",
      },
    });
    expect(consumeEmbeddedToolReceipt(sessionManager, "call-message")).toEqual({
      details: receipt,
    });
  });

  it("keeps an accepted sessions_spawn launch successful even when the event is flagged as an error", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    const runner = await createToolResultRunner();
    const acceptedResult = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
      mode: "run",
    });

    const result = await runner.emitToolResult({
      type: "tool_result",
      toolName: "sessions_spawn",
      toolCallId: "call-spawn",
      input: {},
      content: acceptedResult.content,
      details: acceptedResult.details,
      isError: true,
    });

    expect(result).toEqual({ ...acceptedResult, isError: false });
  });

  it("retains errors without the full spawn contract", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const handler = await createToolResultHandler();
    const content = [{ type: "text", text: "failed" }];
    const details = { status: "accepted" };
    const result = await handler?.({
      toolName: "sessions_spawn",
      toolCallId: "call-invalid-acceptance",
      content,
      details,
      isError: true,
    });
    expect(result).toEqual({ content, details, isError: true });
  });
});
