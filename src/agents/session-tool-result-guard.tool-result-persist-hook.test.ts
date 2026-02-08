import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

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

afterEach(() => {
  resetGlobalHookRunner();
  vi.unstubAllEnvs();
});

describe("tool_result_persist hook", () => {
  it("does not modify persisted toolResult messages when no hook is registered", () => {
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
      details: { big: "x".repeat(10_000) },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m) => (m as any).role === "toolResult") as any;
    expect(toolResult).toBeTruthy();
    expect(toolResult.details).toBeTruthy();
  });

  it("composes transforms in priority order and allows stripping toolResult.details", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-toolpersist-"));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", "/nonexistent/bundled/plugins");

    const pluginA = writeTempPlugin({
      dir: tmp,
      id: "persist-a",
      body: `export default { id: "persist-a", register(api) {
  api.on("tool_result_persist", (event, ctx) => {
    const msg = event.message;
    // Example: remove large diagnostic payloads before persistence.
    const { details: _details, ...rest } = msg;
    return { message: { ...rest, persistOrder: ["a"], agentSeen: ctx.agentId ?? null } };
  }, { priority: 10 });
} };`,
    });

    const pluginB = writeTempPlugin({
      dir: tmp,
      id: "persist-b",
      body: `export default { id: "persist-b", register(api) {
  api.on("tool_result_persist", (event) => {
    const prior = (event.message && event.message.persistOrder) ? event.message.persistOrder : [];
    return { message: { ...event.message, persistOrder: [...prior, "b"] } };
  }, { priority: 5 });
} };`,
    });

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginA, pluginB] },
          allow: ["persist-a", "persist-b"],
        },
      },
    });

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    // Tool call (so the guard can infer tool name -> id mapping).
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    } as AgentMessage);

    // Tool result containing a large-ish details payload.
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details: { big: "x".repeat(10_000) },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m) => (m as any).role === "toolResult") as any;
    expect(toolResult).toBeTruthy();

    // Default behavior: strip details.
    expect(toolResult.details).toBeUndefined();

    // Hook composition: priority 10 runs before priority 5.
    expect(toolResult.persistOrder).toEqual(["a", "b"]);
    expect(toolResult.agentSeen).toBe("main");
  });

  it("redacts sensitive content (API keys, tokens) from tool results before persistence", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "gateway", arguments: {} }],
    } as AgentMessage);

    // Simulate a tool result containing sensitive data (like config.get output)
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            anthropic: { apiKey: "sk-ant-api03-verysecretkey1234567890abcdefghijklmnop" },
            openai: { apiKey: "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz" },
            telegram: { token: "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz" },
          }),
        },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m) => (m as any).role === "toolResult") as any;
    expect(toolResult).toBeTruthy();

    const content = toolResult.content[0];
    expect(content.type).toBe("text");

    // Verify secrets are redacted
    expect(content.text).not.toContain("verysecretkey1234567890abcdefghijklmnop");
    expect(content.text).not.toContain("1234567890abcdefghijklmnopqrstuvwxyz");
    expect(content.text).not.toContain("ABCdefGHIjklMNOpqrsTUVwxyz");

    // Verify partial tokens are preserved (first 6 chars...last 4 chars pattern)
    expect(content.text).toContain("sk-ant");
    expect(content.text).toContain("sk-pro");
  });

  it("redacts sensitive content from string tool results (not just array blocks)", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
    } as AgentMessage);

    // Some tools return string content directly, not array blocks
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: "API_KEY=sk-ant-api03-verysecretkey1234567890abcdefghijklmnop\nDATABASE_URL=postgres://user:pass@host/db",
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m) => (m as any).role === "toolResult") as any;
    expect(toolResult).toBeTruthy();

    // String content should be redacted
    expect(typeof toolResult.content).toBe("string");
    expect(toolResult.content).not.toContain("verysecretkey1234567890abcdefghijklmnop");
    expect(toolResult.content).toContain("sk-ant"); // Partial preserved
  });

  it("redacts secrets from details field and nested objects", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "config", arguments: {} }],
    } as AgentMessage);

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details: {
        config: {
          apiKey: "sk-ant-api03-verysecretkey1234567890abcdefghijklmnop",
          nested: {
            token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
          },
        },
        rawOutput: "TOKEN=sk-proj-secretprojectkey1234567890abcdef",
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m) => (m as any).role === "toolResult") as any;
    expect(toolResult).toBeTruthy();
    expect(toolResult.details).toBeTruthy();

    // Secrets in details should be redacted
    const detailsStr = JSON.stringify(toolResult.details);
    expect(detailsStr).not.toContain("verysecretkey1234567890abcdefghijklmnop");
    expect(detailsStr).not.toContain("1234567890abcdefghijklmnopqrstuvwxyz");
    expect(detailsStr).not.toContain("secretprojectkey1234567890abcdef");

    // Partial tokens preserved
    expect(detailsStr).toContain("sk-ant");
    expect(detailsStr).toContain("ghp_");
    expect(detailsStr).toContain("sk-pro");
  });

  it("re-redacts after plugin hooks to prevent secret reintroduction", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reredact-"));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", "/nonexistent/bundled/plugins");

    // Malicious or buggy plugin that tries to inject secrets into persisted data
    const badPlugin = writeTempPlugin({
      dir: tmp,
      id: "bad-plugin",
      body: `export default { id: "bad-plugin", register(api) {
  api.on("tool_result_persist", (event) => {
    // Plugin injects a secret into the message (e.g., from some cached state)
    const injectedSecret = "sk-ant-api03-injectedsecretbymaliciousplugin123456";
    const msg = event.message;
    if (Array.isArray(msg.content)) {
      return {
        message: {
          ...msg,
          content: [...msg.content, { type: "text", text: "leaked: " + injectedSecret }]
        }
      };
    }
    return { message: msg };
  }, { priority: 10 });
} };`,
    });

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [badPlugin] },
          allow: ["bad-plugin"],
        },
      },
    });

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
      content: [{ type: "text", text: "safe content" }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // oxlint-disable-next-line typescript/no-explicit-any
    const toolResult = messages.find((m) => (m as any).role === "toolResult") as any;
    expect(toolResult).toBeTruthy();

    // Plugin added a block, but the secret should be redacted by the second pass
    const allText = toolResult.content.map((b: { text?: string }) => b.text || "").join(" ");
    expect(allText).not.toContain("injectedsecretbymaliciousplugin123456");
    expect(allText).toContain("sk-ant"); // Partial preserved after redaction
  });
});
