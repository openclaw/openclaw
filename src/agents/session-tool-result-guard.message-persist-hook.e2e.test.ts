import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, afterEach } from "vitest";
import type { PluginRegistry } from "../plugins/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const silentLogger = { debug: () => {}, warn: () => {}, error: () => {} };

/**
 * Helper: create a fresh registry with typed hooks pre-registered.
 * Bypasses jiti/plugin-loader (which conflicts with vitest's module system)
 * and directly populates the registry — giving us precise control over
 * hook registration for each test case.
 */
function createRegistryWithHooks(
  hooks: Array<{
    pluginId: string;
    hookName: string;
    // oxlint-disable-next-line typescript/no-explicit-any
    handler: (...args: any[]) => any;
    priority?: number;
  }>,
): PluginRegistry {
  const { registry } = createPluginRegistry({ logger: silentLogger });
  for (const h of hooks) {
    registry.typedHooks.push({
      pluginId: h.pluginId,
      hookName: h.hookName,
      handler: h.handler,
      priority: h.priority,
      source: "test",
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
  }
  return registry;
}

// oxlint-disable-next-line typescript/no-explicit-any
function getMessages(sm: ReturnType<typeof guardSessionManager>): any[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("message_persist hook", () => {
  it("does not modify persisted messages when no hook is registered", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
    } as AgentMessage);

    const messages = getMessages(sm);
    // oxlint-disable-next-line typescript/no-explicit-any
    const user = messages.find((m: any) => m.role === "user");
    // oxlint-disable-next-line typescript/no-explicit-any
    const assistant = messages.find((m: any) => m.role === "assistant");
    expect(user.content[0].text).toBe("hello");
    expect(assistant.content[0].text).toBe("world");
  });

  it("hook is called for user, assistant, and system messages", () => {
    const registry = createRegistryWithHooks([
      {
        pluginId: "msg-tag",
        hookName: "message_persist",
        // oxlint-disable-next-line typescript/no-explicit-any
        handler: (event: any, ctx: any) => {
          return {
            message: {
              ...event.message,
              tagged: true,
              taggedRole: event.role,
              agentSeen: ctx.agentId ?? null,
            },
          };
        },
        priority: 10,
      },
    ]);
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hey" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "system",
      content: "sys prompt",
    } as AgentMessage);

    const messages = getMessages(sm);
    // oxlint-disable-next-line typescript/no-explicit-any
    const user = messages.find((m: any) => m.role === "user");
    // oxlint-disable-next-line typescript/no-explicit-any
    const assistant = messages.find((m: any) => m.role === "assistant");
    // oxlint-disable-next-line typescript/no-explicit-any
    const system = messages.find((m: any) => m.role === "system");

    expect(user.tagged).toBe(true);
    expect(user.taggedRole).toBe("user");
    expect(user.agentSeen).toBe("main");

    expect(assistant.tagged).toBe(true);
    expect(assistant.taggedRole).toBe("assistant");

    expect(system.tagged).toBe(true);
    expect(system.taggedRole).toBe("system");
  });

  it("hook can transform/replace message content before persistence", () => {
    const registry = createRegistryWithHooks([
      {
        pluginId: "msg-redact",
        hookName: "message_persist",
        // oxlint-disable-next-line typescript/no-explicit-any
        handler: (event: any) => {
          const msg = event.message;
          if (msg.content && Array.isArray(msg.content)) {
            const newContent = msg.content.map(
              // oxlint-disable-next-line typescript/no-explicit-any
              (c: any) => (c.type === "text" ? { ...c, text: "[REDACTED]" } : c),
            );
            return { message: { ...msg, content: newContent } };
          }
          return { message: msg };
        },
        priority: 10,
      },
    ]);
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({ role: "user", content: [{ type: "text", text: "secret data" }] });

    const messages = getMessages(sm);
    // oxlint-disable-next-line typescript/no-explicit-any
    const user = messages.find((m: any) => m.role === "user");
    expect(user.content[0].text).toBe("[REDACTED]");
  });

  it("multiple hooks run in priority order (higher first)", () => {
    const registry = createRegistryWithHooks([
      {
        pluginId: "order-a",
        hookName: "message_persist",
        // oxlint-disable-next-line typescript/no-explicit-any
        handler: (event: any) => {
          const prior = event.message.order || [];
          return { message: { ...event.message, order: [...prior, "a"] } };
        },
        priority: 10,
      },
      {
        pluginId: "order-b",
        hookName: "message_persist",
        // oxlint-disable-next-line typescript/no-explicit-any
        handler: (event: any) => {
          const prior = event.message.order || [];
          return { message: { ...event.message, order: [...prior, "b"] } };
        },
        priority: 5,
      },
    ]);
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

    const messages = getMessages(sm);
    // oxlint-disable-next-line typescript/no-explicit-any
    const user = messages.find((m: any) => m.role === "user");
    // Priority 10 runs first (a), then priority 5 (b)
    expect(user.order).toEqual(["a", "b"]);
  });

  it("async hooks are rejected with a warning (result ignored)", () => {
    const registry = createRegistryWithHooks([
      {
        pluginId: "async-bad",
        hookName: "message_persist",
        handler: async (event: { message: Record<string, unknown> }) => {
          return { message: { ...event.message, asyncDone: true } };
        },
        priority: 10,
      },
    ]);
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    // Should not throw — async result is silently ignored with a warning
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

    const messages = getMessages(sm);
    // oxlint-disable-next-line typescript/no-explicit-any
    const user = messages.find((m: any) => m.role === "user");
    // The async handler's transform should NOT have been applied
    expect(user.asyncDone).toBeUndefined();
  });

  it("toolResult messages pass through both message_persist and tool_result_persist", () => {
    const registry = createRegistryWithHooks([
      {
        pluginId: "dual-hook",
        hookName: "message_persist",
        // oxlint-disable-next-line typescript/no-explicit-any
        handler: (event: any) => {
          return { message: { ...event.message, messagePersistSeen: true } };
        },
        priority: 10,
      },
      {
        pluginId: "dual-hook",
        hookName: "tool_result_persist",
        // oxlint-disable-next-line typescript/no-explicit-any
        handler: (event: any) => {
          return { message: { ...event.message, toolResultPersistSeen: true } };
        },
        priority: 10,
      },
    ]);
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    } as AgentMessage);

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = getMessages(sm);
    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m: any) => m.role === "toolResult");

    // Both hooks should have fired on the toolResult message
    expect(toolResult.messagePersistSeen).toBe(true);
    expect(toolResult.toolResultPersistSeen).toBe(true);
  });
});
