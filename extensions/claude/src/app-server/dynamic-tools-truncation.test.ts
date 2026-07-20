import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  createClaudeDynamicToolBridge,
  DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS,
  resolveClaudeDynamicToolResultMaxChars,
  truncateForToolResult,
} from "./dynamic-tools.js";

function makeTool(name: string, result: unknown): AnyAgentTool {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", additionalProperties: true },
    execute: async () => result,
  } as unknown as AnyAgentTool;
}

describe("truncateForToolResult", () => {
  it("returns input unchanged when under the cap", () => {
    const text = "short";
    expect(truncateForToolResult(text, 100)).toBe(text);
  });

  it("returns input unchanged when exactly at the cap", () => {
    const text = "x".repeat(100);
    expect(truncateForToolResult(text, 100)).toBe(text);
  });

  it("truncates with a visible suffix when over the cap", () => {
    const text = "x".repeat(200);
    const result = truncateForToolResult(text, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toMatch(/\[truncated to 100 chars\]$/);
  });

  it("preserves the start of the text", () => {
    const text = "important opening text" + "x".repeat(20_000);
    const result = truncateForToolResult(text, 200);
    expect(result.startsWith("important opening text")).toBe(true);
  });

  it("returns input unchanged when maxChars is zero or negative (disabled)", () => {
    const text = "x".repeat(50_000);
    expect(truncateForToolResult(text, 0)).toBe(text);
    expect(truncateForToolResult(text, -1)).toBe(text);
  });

  it("default cap matches the documented constant", () => {
    expect(DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS).toBe(16_000);
  });

  it("at the documented default cap, oversized inputs land within 16k chars", () => {
    const text = "y".repeat(20_000);
    const result = truncateForToolResult(text, DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS);
    expect(result).toMatch(/\[truncated to 16000 chars\]$/);
  });
});

describe("resolveClaudeDynamicToolResultMaxChars", () => {
  it("returns the documented default when no config is supplied", () => {
    expect(resolveClaudeDynamicToolResultMaxChars(undefined)).toBe(
      DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS,
    );
    expect(resolveClaudeDynamicToolResultMaxChars({})).toBe(
      DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS,
    );
  });

  it("reads agents.defaults.contextLimits.toolResultMaxChars when no agentId", () => {
    const config = { agents: { defaults: { contextLimits: { toolResultMaxChars: 4_000 } } } };
    expect(resolveClaudeDynamicToolResultMaxChars({ config } as never)).toBe(4_000);
  });

  it("prefers the agent-specific value over defaults", () => {
    const config = {
      agents: {
        defaults: { contextLimits: { toolResultMaxChars: 4_000 } },
        list: [{ id: "alice", contextLimits: { toolResultMaxChars: 8_000 } }],
      },
    };
    expect(resolveClaudeDynamicToolResultMaxChars({ config, agentId: "alice" } as never)).toBe(
      8_000,
    );
  });

  it("falls back to defaults when the named agent has no override", () => {
    const config = {
      agents: {
        defaults: { contextLimits: { toolResultMaxChars: 4_000 } },
        list: [{ id: "bob", contextLimits: { toolResultMaxChars: 2_000 } }],
      },
    };
    expect(resolveClaudeDynamicToolResultMaxChars({ config, agentId: "alice" } as never)).toBe(
      4_000,
    );
  });

  it("ignores non-positive configured values and falls back to the default", () => {
    const config = { agents: { defaults: { contextLimits: { toolResultMaxChars: 0 } } } };
    expect(resolveClaudeDynamicToolResultMaxChars({ config } as never)).toBe(
      DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS,
    );
  });
});

describe("searchable / direct loading + namespace metadata", () => {
  it("emits no namespace/deferLoading when loading=direct (default)", () => {
    const bridge = createClaudeDynamicToolBridge({
      tools: [makeTool("openclaw_a", null), makeTool("openclaw_b", null)],
    });
    for (const spec of bridge.specs) {
      expect(spec.namespace).toBeUndefined();
      expect(spec.deferLoading).toBeUndefined();
    }
  });

  it("sets namespace + deferLoading on every spec when loading=searchable", () => {
    const bridge = createClaudeDynamicToolBridge({
      tools: [makeTool("openclaw_a", null), makeTool("openclaw_b", null)],
      loading: "searchable",
    });
    for (const spec of bridge.specs) {
      expect(spec.namespace).toBe("openclaw");
      expect(spec.deferLoading).toBe(true);
    }
  });

  it("keeps explicit directToolNames eagerly registered in searchable mode", () => {
    const bridge = createClaudeDynamicToolBridge({
      tools: [makeTool("openclaw_lazy", null), makeTool("openclaw_eager", null)],
      loading: "searchable",
      directToolNames: ["openclaw_eager"],
    });
    const lazy = bridge.specs.find((s) => s.name === "openclaw_lazy");
    const eager = bridge.specs.find((s) => s.name === "openclaw_eager");
    expect(lazy?.deferLoading).toBe(true);
    expect(lazy?.namespace).toBe("openclaw");
    expect(eager?.deferLoading).toBeUndefined();
    expect(eager?.namespace).toBeUndefined();
  });

  it("preserves the ALWAYS_DIRECT allowlist (sessions_yield) even in searchable mode", () => {
    const bridge = createClaudeDynamicToolBridge({
      tools: [makeTool("sessions_yield", null), makeTool("other_tool", null)],
      loading: "searchable",
    });
    const yieldSpec = bridge.specs.find((s) => s.name === "sessions_yield");
    const otherSpec = bridge.specs.find((s) => s.name === "other_tool");
    expect(yieldSpec?.deferLoading).toBeUndefined();
    expect(otherSpec?.deferLoading).toBe(true);
  });
});

describe("dynamic-tool result aggregate budgeting", () => {
  it("passes a single-block result through unchanged when under the cap", async () => {
    const bridge = createClaudeDynamicToolBridge({
      tools: [makeTool("read", { content: [{ type: "text", text: "hello" }] })],
      hookContext: {
        config: { agents: { defaults: { contextLimits: { toolResultMaxChars: 1_000 } } } } as never,
      },
    });
    const out = await bridge.handleToolCall({
      tool: "read",
      callId: "c1",
      threadId: "thr",
      turnId: "turn",
      arguments: {},
    });
    expect(out.success).toBe(true);
    expect(out.contentItems).toEqual([{ type: "inputText", text: "hello" }]);
  });

  it("aggregates across blocks so a multi-block result whose sum exceeds the cap is truncated", async () => {
    // Two blocks, each 100 chars, cap 150 — sum (200) > cap, so the second
    // block should be truncated (or absent) with a notice appended.
    const block = "x".repeat(100);
    const bridge = createClaudeDynamicToolBridge({
      tools: [
        makeTool("multi", {
          content: [
            { type: "text", text: block },
            { type: "text", text: block },
          ],
        }),
      ],
      hookContext: {
        config: { agents: { defaults: { contextLimits: { toolResultMaxChars: 150 } } } } as never,
      },
    });
    const out = await bridge.handleToolCall({
      tool: "multi",
      callId: "c1",
      threadId: "thr",
      turnId: "turn",
      arguments: {},
    });
    expect(out.success).toBe(true);
    const totalText = out.contentItems
      .filter((item): item is { type: "inputText"; text: string } => item.type === "inputText")
      .map((item) => item.text)
      .join("");
    expect(totalText.length).toBeLessThanOrEqual(150);
    expect(totalText).toMatch(/OpenClaw truncated dynamic tool result/);
    expect(totalText).toContain("original 200 chars");
  });

  it("preserves image items when text gets truncated", async () => {
    const bigText = "y".repeat(1_000);
    const bridge = createClaudeDynamicToolBridge({
      tools: [
        makeTool("vision", {
          content: [
            { type: "text", text: bigText },
            { type: "image", url: "https://example.test/img.png" },
          ],
        }),
      ],
      hookContext: {
        config: { agents: { defaults: { contextLimits: { toolResultMaxChars: 200 } } } } as never,
      },
    });
    const out = await bridge.handleToolCall({
      tool: "vision",
      callId: "c1",
      threadId: "thr",
      turnId: "turn",
      arguments: {},
    });
    const hasImage = out.contentItems.some(
      (item) => item.type === "inputImage" && item.imageUrl === "https://example.test/img.png",
    );
    expect(hasImage).toBe(true);
  });
});
