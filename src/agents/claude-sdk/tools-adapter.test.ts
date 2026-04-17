import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SDK_TOOL_PRESET,
  buildCanUseTool,
  buildMcpServersConfig,
} from "./tools-adapter.js";

function makeStdioMcp(label: string): McpServerConfig {
  return { type: "stdio", command: "node", args: [label] };
}

describe("buildCanUseTool", () => {
  it("returns allow behavior when the gate allows", async () => {
    const gate = vi.fn(async () => ({ kind: "allow" as const }));
    const canUse = buildCanUseTool({ gate });

    const result = await canUse("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "tu_1",
    } as unknown as Parameters<typeof canUse>[2]);
    expect(result.behavior).toBe("allow");
    expect(gate).toHaveBeenCalledWith({ toolName: "Bash", input: { command: "ls" } });
  });

  it("returns deny behavior with the gate's message when the gate denies", async () => {
    const gate = vi.fn(async () => ({
      kind: "deny" as const,
      message: "not allowed in this scope",
    }));
    const canUse = buildCanUseTool({ gate });

    const result = await canUse("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "tu_1",
    } as unknown as Parameters<typeof canUse>[2]);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe("not allowed in this scope");
      expect(result.interrupt).toBe(false);
    }
  });
});

describe("buildMcpServersConfig", () => {
  it("returns OpenClaw servers alone when no SDK-native are provided", () => {
    const result = buildMcpServersConfig({
      openclawMcp: { a: makeStdioMcp("a"), b: makeStdioMcp("b") },
    });
    expect(Object.keys(result)).toEqual(["a", "b"]);
  });

  it("merges and sorts deterministically for prompt-cache stability", () => {
    const result = buildMcpServersConfig({
      openclawMcp: { zulu: makeStdioMcp("zulu"), alpha: makeStdioMcp("alpha") },
      sdkNative: { mike: makeStdioMcp("mike") },
    });
    expect(Object.keys(result)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("lets OpenClaw servers win on name collisions (deterministic first-wins)", () => {
    const result = buildMcpServersConfig({
      openclawMcp: { conflict: makeStdioMcp("from-openclaw") },
      sdkNative: { conflict: makeStdioMcp("from-sdk-native") },
    });
    expect(result.conflict).toMatchObject({ args: ["from-openclaw"] });
  });
});

describe("DEFAULT_SDK_TOOL_PRESET", () => {
  it("pins the claude_code preset so OpenClaw workspaces get Bash/Read/Edit/etc.", () => {
    expect(DEFAULT_SDK_TOOL_PRESET).toEqual({ type: "preset", preset: "claude_code" });
  });
});
