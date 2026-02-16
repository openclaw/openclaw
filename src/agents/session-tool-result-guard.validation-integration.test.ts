import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

describe("session tool result validation integration", () => {
  it("allows valid tool results through unchanged", () => {
    const warnings: string[] = [];
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "test-session",
      warn: (msg) => warnings.push(msg),
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    } as AgentMessage);

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "file contents here" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const toolResult = messages.find((m) => (m as { role: string }).role === "toolResult") as {
      content: Array<{ text: string }>;
    };
    expect(toolResult).toBeTruthy();
    expect(toolResult.content[0].text).toBe("file contents here");
    expect(warnings).toHaveLength(0);
  });

  it("sanitizes corrupted tool result and continues session", () => {
    const warnings: string[] = [];
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "test-session",
      warn: (msg) => warnings.push(msg),
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);

    // Create a message with circular reference (will fail JSON.stringify)
    const corrupted: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: [{ type: "text", text: "ok" }],
    };
    corrupted.circular = corrupted;

    sm.appendMessage(corrupted as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const toolResult = messages.find((m) => (m as { role: string }).role === "toolResult") as {
      isError: boolean;
      content: Array<{ text: string }>;
    };

    // Session should continue with sanitized message
    expect(toolResult).toBeTruthy();
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain("corrupted");

    // Warning should have been emitted
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("exec");
  });

  it("handles non-serializable values gracefully", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "test-session",
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    } as AgentMessage);

    // BigInt is not JSON-serializable
    const messageWithBigInt = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "ok" }],
      someNumber: BigInt(9007199254740991),
    } as unknown as AgentMessage;

    sm.appendMessage(messageWithBigInt);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const toolResult = messages.find((m) => (m as { role: string }).role === "toolResult");

    // Should have a result (sanitized)
    expect(toolResult).toBeTruthy();

    // The persisted message should be valid JSON
    expect(() => JSON.stringify(toolResult)).not.toThrow();
  });

  it("validates plugin output and sanitizes if plugin introduces corruption", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-validation-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    // Create a plugin that introduces a circular reference
    const badPlugin = writeTempPlugin({
      dir: tmp,
      id: "bad-plugin",
      body: `export default { id: "bad-plugin", register(api) {
  api.on("tool_result_persist", (event) => {
    const msg = event.message;
    // Introduce circular reference (bad plugin behavior)
    const corrupted = { ...msg, badField: {} };
    corrupted.badField.self = corrupted;
    return { message: corrupted };
  });
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

    const warnings: string[] = [];
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "test-session",
      warn: (msg) => warnings.push(msg),
    });

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    } as AgentMessage);

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "original content" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const toolResult = messages.find((m) => (m as { role: string }).role === "toolResult");

    // Result should be valid JSON (sanitized after plugin corruption)
    expect(toolResult).toBeTruthy();
    expect(() => JSON.stringify(toolResult)).not.toThrow();
  });

  it("session continues even when multiple tool results are corrupted", () => {
    const warnings: string[] = [];
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "test-session",
      warn: (msg) => warnings.push(msg),
    });

    // First tool call and corrupted result
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "tool1", arguments: {} }],
    } as AgentMessage);

    const corrupted1: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_1",
    };
    corrupted1.loop = corrupted1;
    sm.appendMessage(corrupted1 as AgentMessage);

    // Second tool call and valid result
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_2", name: "tool2", arguments: {} }],
    } as AgentMessage);

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_2",
      content: [{ type: "text", text: "this one is fine" }],
    } as AgentMessage);

    // Third tool call and corrupted result
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_3", name: "tool3", arguments: {} }],
    } as AgentMessage);

    const corrupted2: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_3",
    };
    corrupted2.ref = corrupted2;
    sm.appendMessage(corrupted2 as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // All messages should be present and valid
    expect(messages.length).toBe(6); // 3 assistant + 3 toolResult

    // All should be valid JSON
    for (const msg of messages) {
      expect(() => JSON.stringify(msg)).not.toThrow();
    }

    // Two warnings for two corrupted results
    expect(warnings.length).toBe(2);
  });
});
