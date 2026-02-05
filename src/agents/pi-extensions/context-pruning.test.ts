import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifactRegistry } from "../artifact-registry.js";
import {
  computeEffectiveSettings,
  default as contextPruningExtension,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  pruneContextMessages,
} from "./context-pruning.js";
import { writeToolResultArtifact } from "./context-pruning/artifacts.js";
import { getContextPruningRuntime, setContextPruningRuntime } from "./context-pruning/runtime.js";

function toolText(msg: AgentMessage): string {
  if (msg.role !== "toolResult") {
    throw new Error("expected toolResult");
  }
  const first = msg.content.find((b) => b.type === "text");
  if (!first || first.type !== "text") {
    return "";
  }
  return first.text;
}

function findToolResult(messages: AgentMessage[], toolCallId: string): AgentMessage {
  const msg = messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
  if (!msg) {
    throw new Error(`missing toolResult: ${toolCallId}`);
  }
  return msg;
}

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeImageToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: params.text },
    ],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

describe("context-pruning", () => {
  it("mode off disables pruning", () => {
    expect(computeEffectiveSettings({ mode: "off" })).toBeNull();
    expect(computeEffectiveSettings({})).toBeNull();
  });

  it("does not touch tool results after the last N assistants", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
      makeUser("u2"),
      makeAssistant("a2"),
      makeToolResult({
        toolCallId: "t2",
        toolName: "exec",
        text: "y".repeat(20_000),
      }),
      makeUser("u3"),
      makeAssistant("a3"),
      makeToolResult({
        toolCallId: "t3",
        toolName: "exec",
        text: "z".repeat(20_000),
      }),
      makeUser("u4"),
      makeAssistant("a4"),
      makeToolResult({
        toolCallId: "t4",
        toolName: "exec",
        text: "w".repeat(20_000),
      }),
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 3,
      softTrimRatio: 0.0,
      hardClearRatio: 0.0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    };

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;

    const next = pruneContextMessages({ messages, settings, ctx });

    expect(toolText(findToolResult(next, "t2"))).toContain("y".repeat(20_000));
    expect(toolText(findToolResult(next, "t3"))).toContain("z".repeat(20_000));
    expect(toolText(findToolResult(next, "t4"))).toContain("w".repeat(20_000));
    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("never prunes tool results before the first user message", () => {
    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0.0,
      hardClearRatio: 0.0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    };

    const messages: AgentMessage[] = [
      makeAssistant("bootstrap tool calls"),
      makeToolResult({
        toolCallId: "t0",
        toolName: "read",
        text: "x".repeat(20_000),
      }),
      makeAssistant("greeting"),
      makeUser("u1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "y".repeat(20_000),
      }),
    ];

    const next = pruneContextMessages({
      messages,
      settings,
      ctx: { model: { contextWindow: 1000 } } as unknown as ExtensionContext,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 1000,
    });

    expect(toolText(findToolResult(next, "t0"))).toBe("x".repeat(20_000));
    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("externalizes large tool results into artifacts when configured", () => {
    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0.0,
      hardClearRatio: 1.0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    };

    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeImageToolResult({
        toolCallId: "t1",
        toolName: "browser",
        text: "x".repeat(500),
      }),
    ];

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;

    const stored: Array<{ toolName?: string; content: unknown }> = [];
    const next = pruneContextMessages({
      messages,
      settings,
      ctx,
      isToolPrunable: () => true,
      storeArtifact: ({ toolName, content }) => {
        stored.push({ toolName, content });
        return {
          id: "art_test",
          type: "tool-result",
          toolName,
          createdAt: "now",
          sizeBytes: 1024,
          summary: "summary",
          path: "/tmp/artifacts/art_test.json",
        };
      },
    });

    const text = toolText(findToolResult(next, "t1"));
    expect(text).toContain("art_test");
    expect(stored).toHaveLength(1);
  });

  it("hard-clear removes eligible tool results before cutoff", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
      makeToolResult({
        toolCallId: "t2",
        toolName: "exec",
        text: "y".repeat(20_000),
      }),
      makeUser("u2"),
      makeAssistant("a2"),
      makeToolResult({
        toolCallId: "t3",
        toolName: "exec",
        text: "z".repeat(20_000),
      }),
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 1,
      softTrimRatio: 10.0,
      hardClearRatio: 0.0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
    };

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;
    const next = pruneContextMessages({ messages, settings, ctx });

    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
    expect(toolText(findToolResult(next, "t2"))).toBe("[cleared]");
    // Tool results after the last assistant are protected.
    expect(toolText(findToolResult(next, "t3"))).toContain("z".repeat(20_000));
  });

  it("uses contextWindow override when ctx.model is missing", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
      makeAssistant("a2"),
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0,
      hardClearRatio: 0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    };

    const next = pruneContextMessages({
      messages,
      settings,
      ctx: { model: undefined } as unknown as ExtensionContext,
      contextWindowTokensOverride: 1000,
    });

    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("reads per-session settings from registry", async () => {
    const sessionManager = {};

    setContextPruningRuntime(sessionManager, {
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 0,
        softTrimRatio: 0,
        hardClearRatio: 0,
        minPrunableToolChars: 0,
        hardClear: { enabled: true, placeholder: "[cleared]" },
        softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
      },
      contextWindowTokens: 1000,
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 1000,
    });

    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
      makeAssistant("a2"),
    ];

    let handler:
      | ((
          event: { messages: AgentMessage[] },
          ctx: ExtensionContext,
        ) => { messages: AgentMessage[] } | undefined)
      | undefined;

    const api = {
      on: (name: string, fn: unknown) => {
        if (name === "context") {
          handler = fn as typeof handler;
        }
      },
      appendEntry: (_type: string, _data?: unknown) => {},
    } as unknown as ExtensionAPI;

    contextPruningExtension(api);

    if (!handler) {
      throw new Error("missing context handler");
    }

    const result = handler({ messages }, {
      model: undefined,
      sessionManager,
    } as unknown as ExtensionContext);

    if (!result) {
      throw new Error("expected handler to return messages");
    }
    expect(toolText(findToolResult(result.messages, "t1"))).toBe("[cleared]");
  });

  it("cache-ttl prunes once and resets the ttl window", () => {
    const sessionManager = {};
    const lastTouch = Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 1000;

    setContextPruningRuntime(sessionManager, {
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 0,
        softTrimRatio: 0,
        hardClearRatio: 0,
        minPrunableToolChars: 0,
        hardClear: { enabled: true, placeholder: "[cleared]" },
        softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
      },
      contextWindowTokens: 1000,
      isToolPrunable: () => true,
      lastCacheTouchAt: lastTouch,
    });

    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
    ];

    let handler:
      | ((
          event: { messages: AgentMessage[] },
          ctx: ExtensionContext,
        ) => { messages: AgentMessage[] } | undefined)
      | undefined;

    const api = {
      on: (name: string, fn: unknown) => {
        if (name === "context") {
          handler = fn as typeof handler;
        }
      },
      appendEntry: (_type: string, _data?: unknown) => {},
    } as unknown as ExtensionAPI;

    contextPruningExtension(api);
    if (!handler) {
      throw new Error("missing context handler");
    }

    const first = handler({ messages }, {
      model: undefined,
      sessionManager,
    } as unknown as ExtensionContext);
    if (!first) {
      throw new Error("expected first prune");
    }
    expect(toolText(findToolResult(first.messages, "t1"))).toBe("[cleared]");

    const runtime = getContextPruningRuntime(sessionManager);
    if (!runtime?.lastCacheTouchAt) {
      throw new Error("expected lastCacheTouchAt");
    }
    expect(runtime.lastCacheTouchAt).toBeGreaterThan(lastTouch);

    const second = handler({ messages }, {
      model: undefined,
      sessionManager,
    } as unknown as ExtensionContext);
    expect(second).toBeUndefined();
  });

  it("respects tools allow/deny (deny wins; wildcards supported)", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "Exec",
        text: "x".repeat(20_000),
      }),
      makeToolResult({
        toolCallId: "t2",
        toolName: "Browser",
        text: "y".repeat(20_000),
      }),
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0.0,
      hardClearRatio: 0.0,
      minPrunableToolChars: 0,
      tools: { allow: ["ex*"], deny: ["exec"] },
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    };

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;
    const next = pruneContextMessages({ messages, settings, ctx });

    // Deny wins => exec is not pruned, even though allow matches.
    expect(toolText(findToolResult(next, "t1"))).toContain("x".repeat(20_000));
    // allow is non-empty and browser is not allowed => never pruned.
    expect(toolText(findToolResult(next, "t2"))).toContain("y".repeat(20_000));
  });

  it("skips tool results that contain images (no soft trim, no hard clear)", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeImageToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0.0,
      hardClearRatio: 0.0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    };

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;
    const next = pruneContextMessages({ messages, settings, ctx });

    const tool = findToolResult(next, "t1");
    if (!tool || tool.role !== "toolResult") {
      throw new Error("unexpected pruned message list shape");
    }
    expect(tool.content.some((b) => b.type === "image")).toBe(true);
    expect(toolText(tool)).toContain("x".repeat(20_000));
  });

  it("soft-trims across block boundaries", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [
          { type: "text", text: "AAAAA" },
          { type: "text", text: "BBBBB" },
        ],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0.0,
      hardClearRatio: 10.0,
      softTrim: { maxChars: 5, headChars: 7, tailChars: 3 },
    };

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;
    const next = pruneContextMessages({ messages, settings, ctx });

    const text = toolText(findToolResult(next, "t1"));
    expect(text).toContain("AAAAA\nB");
    expect(text).toContain("BBB");
    expect(text).toContain("[Tool result trimmed:");
  });

  it("soft-trims oversized tool results and preserves head/tail with a note", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "abcdefghij".repeat(1000),
      }),
    ];

    const settings = {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
      keepLastAssistants: 0,
      softTrimRatio: 0.0,
      hardClearRatio: 10.0,
      minPrunableToolChars: 0,
      hardClear: { enabled: true, placeholder: "[cleared]" },
      softTrim: { maxChars: 10, headChars: 6, tailChars: 6 },
    };

    const ctx = {
      model: { contextWindow: 1000 },
    } as unknown as ExtensionContext;
    const next = pruneContextMessages({ messages, settings, ctx });

    const tool = findToolResult(next, "t1");
    const text = toolText(tool);
    expect(text).toContain("abcdef");
    expect(text).toContain("efghij");
    expect(text).toContain("[Tool result trimmed:");
  });
});

describe("context-pruning artifacts", () => {
  it("writes tool result artifact with deterministic summary", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-artifacts-"));
    const ref = writeToolResultArtifact({
      artifactDir: dir,
      toolName: "exec",
      content: [{ type: "text", text: "hello\nworld" }],
    });

    expect(ref.id).toContain("art_");
    expect(ref.toolName).toBe("exec");
    expect(ref.summary).toContain("hello");
    expect(fs.existsSync(ref.path)).toBe(true);
    expect(ref.hash).toBeTruthy();
    const raw = fs.readFileSync(ref.path, "utf8");
    expect(raw).toContain('"type": "tool-result"');

    const registry = readArtifactRegistry(dir);
    expect(registry).toHaveLength(1);
    expect(registry[0]?.artifact?.id).toBe(ref.id);
    expect(registry[0]?.hash).toBe(ref.hash);
  });

  it("extension replaces tool results with artifact placeholders", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-artifacts-"));
    const runtimeSession = {};
    setContextPruningRuntime(runtimeSession, {
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        mode: "cache-ttl",
        ttlMs: 1,
        keepLastAssistants: 0,
        softTrimRatio: 0.0,
        hardClearRatio: 1.0,
        minPrunableToolChars: 0,
        hardClear: { enabled: true, placeholder: "[cleared]" },
        softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
      },
      contextWindowTokens: 1000,
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - 10000,
      artifactDir: dir,
    });

    let handler:
      | ((
          event: { messages: AgentMessage[] },
          ctx: ExtensionContext,
        ) => { messages: AgentMessage[] })
      | undefined;
    const api = {
      on: (name: string, fn: unknown) => {
        if (name === "context") {
          handler = fn as typeof handler;
        }
      },
      appendEntry: () => {},
    } as unknown as ExtensionAPI;

    contextPruningExtension(api);
    if (!handler) {
      throw new Error("missing context handler");
    }

    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeImageToolResult({
        toolCallId: "t1",
        toolName: "browser",
        text: "x".repeat(500),
      }),
    ];

    const res = handler({ messages }, {
      model: { contextWindow: 1000 },
      sessionManager: runtimeSession,
    } as ExtensionContext);
    const text = toolText(findToolResult(res.messages, "t1"));
    expect(text).toContain("stored as artifact");
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
  });
});
