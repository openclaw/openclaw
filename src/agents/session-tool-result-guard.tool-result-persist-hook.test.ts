import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultEvent, SessionManager } from "@mariozechner/pi-coding-agent";
import { SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/runner.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { buildEmbeddedExtensionFactories } from "./pi-embedded-runner/extensions.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

type ToolResultPatch = {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
};

type ToolResultHandler = (
  event: ToolResultEvent,
) => ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>;

function appendToolCall(sm: ReturnType<typeof PiSessionManager.inMemory>) {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
  } as AgentMessage);
}

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

function createToolResult(
  text = "ok",
  details: unknown = { big: "x".repeat(10_000) },
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    isError: false,
    content: [{ type: "text", text }],
    ...(details !== undefined ? { details } : {}),
  } as AgentMessage;
}

function appendToolResult(
  sm: ReturnType<typeof PiSessionManager.inMemory>,
  message: AgentMessage = createToolResult(),
) {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    ...(message as unknown as Record<string, unknown>),
  } as unknown as AgentMessage);
}

function appendToolCallAndResult(sm: ReturnType<typeof PiSessionManager.inMemory>) {
  appendToolCall(sm);
  appendToolResult(sm);
}

function getPersistedMessages(sm: ReturnType<typeof PiSessionManager.inMemory>) {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message);
}

function getPersistedToolResult(sm: ReturnType<typeof PiSessionManager.inMemory>) {
  return getPersistedMessages(sm).find(
    (message) => (message as { role?: unknown }).role === "toolResult",
  ) as (AgentMessage & { details?: unknown }) | undefined;
}

function getToolResultText(message: AgentMessage | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const [first] = content;
  return first &&
    typeof first === "object" &&
    (first as { type?: unknown }).type === "text" &&
    typeof (first as { text?: unknown }).text === "string"
    ? (first as { text: string }).text
    : "";
}

function normalizeToolResultEventContent(content: unknown): ToolResultEvent["content"] {
  if (Array.isArray(content)) {
    return content as ToolResultEvent["content"];
  }
  if (typeof content === "string") {
    return content as unknown as ToolResultEvent["content"];
  }
  return [];
}

function toToolResultEvent(message: AgentMessage): ToolResultEvent {
  const record = message as unknown as Record<string, unknown>;
  return {
    type: "tool_result",
    toolName: typeof record.toolName === "string" ? record.toolName : "read",
    toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : "call_1",
    input: { path: "README.md" },
    content: normalizeToolResultEventContent(record.content),
    details: record.details,
    isError: record.isError === true,
  } as ToolResultEvent;
}

function applyToolResultPatch(message: AgentMessage, event: ToolResultEvent): AgentMessage {
  return {
    ...(message as unknown as Record<string, unknown>),
    content: event.content,
    ...(event.details !== undefined ? { details: event.details } : {}),
  } as AgentMessage;
}

async function emitToolResultThroughRunner(
  event: ToolResultEvent,
  handlers: ToolResultHandler[],
): Promise<ToolResultEvent> {
  const extensions = handlers.map((handler, index) => ({
    path: `<persist-test:${index + 1}>`,
    handlers: new Map([["tool_result", [handler]]]),
    tools: new Map(),
    commands: new Map(),
  }));
  const runner = new ExtensionRunner(
    extensions as never,
    {} as never,
    process.cwd(),
    {} as SessionManager,
    {} as never,
  );
  const emitted = await runner.emitToolResult(event);
  return {
    ...event,
    ...emitted,
  } as ToolResultEvent;
}

async function canonicalizeToolResultThroughBridge(
  sessionManager: SessionManager,
  message: AgentMessage,
  extraHandlers: ToolResultHandler[] = [],
  hookRunnerOverride:
    | Parameters<typeof buildEmbeddedExtensionFactories>[0]["hookRunner"]
    | null = null,
): Promise<AgentMessage> {
  const hookRunner = hookRunnerOverride ?? getGlobalHookRunner();
  const factories = buildEmbeddedExtensionFactories({
    cfg: undefined,
    sessionManager,
    provider: "openai",
    modelId: "gpt-5.4",
    model: undefined,
    hookRunner: hookRunner ?? undefined,
    agentId: "main",
    sessionKey: "main",
    sessionId: "session-1",
    runId: "run-1",
  });

  const handlers: ToolResultHandler[] = [];
  for (const factory of factories) {
    const on = vi.fn();
    void factory({ on } as never);
    const toolResultHandler = on.mock.calls.find(
      ([eventName]) => eventName === "tool_result",
    )?.[1] as ToolResultHandler | undefined;
    if (toolResultHandler) {
      handlers.push(toolResultHandler);
    }
  }

  if (handlers.length === 0 && extraHandlers.length === 0) {
    return message;
  }

  const finalEvent = await emitToolResultThroughRunner(toToolResultEvent(message), [
    ...handlers,
    ...extraHandlers,
  ]);
  return applyToolResultPatch(message, finalEvent);
}

afterEach(() => {
  resetGlobalHookRunner();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("tool_result persistence with tool_result_before_model", () => {
  it("does not modify persisted toolResult messages when no hook is registered", () => {
    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCall(sm);
    appendToolResult(sm);

    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();
    expect(getToolResultText(toolResult)).toBe("ok");
    expect(toolResult?.details).toEqual({ big: "x".repeat(10_000) });
  });

  it("persists canonical content by default while keeping raw details unchanged", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "canonical",
          handler: () => ({ text: "canonical text" }),
        },
      ]),
    );

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCall(sm);
    const canonical = await canonicalizeToolResultThroughBridge(sm, createToolResult("raw text"));
    appendToolResult(sm, canonical);

    const toolResult = getPersistedToolResult(sm);
    expect(getToolResultText(toolResult)).toBe("canonical text");
    expect(toolResult?.details).toEqual({ big: "x".repeat(10_000) });
  });
  it("reapplies the cap after tool_result_persist expands a tool result", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-toolpersist-expand-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const plugin = writeTempPlugin({
      dir: tmp,
      id: "persist-expand",
      body: `export default { id: "persist-expand", register(api) {
  api.on("tool_result_persist", (event) => {
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: "y".repeat(5000) }],
      },
    };
  }, { priority: 10 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [plugin] },
          allow: ["persist-expand"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      contextWindowTokens: 100,
    });

    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();
    const text = getToolResultText(toolResult);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain("truncated");
  });

  it("persists later ordinary tool_result content rewrites after early canonicalization", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "canonical",
          handler: () => ({ text: "canonical text" }),
        },
      ]),
    );

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCall(sm);
    const canonical = await canonicalizeToolResultThroughBridge(sm, createToolResult("raw text"), [
      () => ({
        content: [{ type: "text", text: "late overwrite" }],
      }),
    ]);
    appendToolResult(sm, canonical);

    expect(getToolResultText(getPersistedToolResult(sm))).toBe("late overwrite");
  });

  it("lets tool_result_persist observe canonical content plus raw details and rewrite the transcript", async () => {
    const seen = {
      content: "",
      details: undefined as unknown,
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "canonical",
          handler: (event) => {
            const hookEvent = event as { text: string };
            return { text: `${hookEvent.text} [canonical]` };
          },
        },
        {
          hookName: "tool_result_persist",
          pluginId: "persist",
          handler: (event) => {
            const persistEvent = event as { message: AgentMessage & { details?: unknown } };
            seen.content = getToolResultText(persistEvent.message);
            seen.details = persistEvent.message.details;
            return {
              message: {
                ...(persistEvent.message as unknown as Record<string, unknown>),
                content: [{ type: "text", text: "persisted text" }],
                details: { summary: "persisted" },
              } as AgentMessage,
            };
          },
        },
      ]),
    );

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCall(sm);
    const canonical = await canonicalizeToolResultThroughBridge(sm, createToolResult("raw text"));
    appendToolResult(sm, canonical);

    expect(seen.content).toBe("raw text [canonical]");
    expect(seen.details).toEqual({ big: "x".repeat(10_000) });
    const persisted = getPersistedToolResult(sm);
    expect(getToolResultText(persisted)).toBe("persisted text");
    expect(persisted?.details).toEqual({ summary: "persisted" });
  });

  it("does not invent empty details objects for no-details tools", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "canonical",
          handler: () => ({ text: "canonical text" }),
        },
      ]),
    );

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCall(sm);
    const canonical = await canonicalizeToolResultThroughBridge(sm, {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "raw text" }],
    } as AgentMessage);
    appendToolResult(sm, canonical);

    const persisted = getPersistedToolResult(sm) as Record<string, unknown> | undefined;
    expect(getToolResultText(persisted as AgentMessage | undefined)).toBe("canonical text");
    expect(persisted).toBeTruthy();
    expect((persisted as { details?: unknown } | undefined)?.details).toBeUndefined();
  });

  it("preserves raw persisted content when tool_result_before_model throws", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "boom",
          handler: () => {
            throw new Error("boom");
          },
        },
      ]),
    );

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCall(sm);
    const canonical = await canonicalizeToolResultThroughBridge(sm, createToolResult("raw text"));
    appendToolResult(sm, canonical);

    const persisted = getPersistedToolResult(sm);
    expect(getToolResultText(persisted)).toBe("raw text");
    expect(persisted?.details).toEqual({ big: "x".repeat(10_000) });
  });

  it("reapplies the cap after before_message_write expands a tool result", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-before-write-expand-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const plugin = writeTempPlugin({
      dir: tmp,
      id: "before-write-expand",
      body: `export default { id: "before-write-expand", register(api) {
  api.on("before_message_write", (event) => {
    if (event.message?.role !== "toolResult") return;
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: "z".repeat(5000) }],
      },
    };
  }, { priority: 10 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [plugin] },
          allow: ["before-write-expand"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(PiSessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      contextWindowTokens: 100,
    });

    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();
    const text = getToolResultText(toolResult);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain("truncated");
  });
});
