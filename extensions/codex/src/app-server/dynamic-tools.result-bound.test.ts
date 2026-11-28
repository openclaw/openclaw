import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { estimateToolResultTextChars } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  callTool,
  createBridge,
  createTool,
  textToolResult,
  type BridgeOptions,
} from "./dynamic-tools.test-support.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function bridgeReturning(
  name: string,
  result: AgentToolResult<unknown>,
  hook: BridgeOptions["hookContext"],
) {
  return createBridge([createTool(name, { execute: vi.fn(async () => result) })], {
    hookContext: hook,
  });
}

function texts(response: Awaited<ReturnType<typeof callTool>>) {
  return response.contentItems
    .map((item) => (item.type === "inputText" && typeof item.text === "string" ? item.text : ""))
    .join("");
}

describe("Codex dynamic-tool results go through the one tool-result bound", () => {
  // Production: 292 of 719 Codex prefix cuts in 7 days left the untrusted-content wrapper open.
  it("keeps head and tail with the wrapper intact and names no Gateway path", async () => {
    const rows = Array.from({ length: 6_000 }, (_, i) => `row ${String(i).padStart(6, "0")}`);
    const wrapped = wrapExternalContent([...rows, "LAST-ROW"].join("\n"), { source: "api" });
    const bridge = bridgeReturning("github_read", textToolResult(wrapped), {
      contextWindowTokens: 128_000,
    });
    const text = texts(await callTool(bridge, "github_read", {}, "call-wrapped"));
    const markers = [
      ...text.matchAll(/<<<(END_)?EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>/gu),
    ];

    expect(markers.map((match) => (match[1] ? "end" : "start"))).toEqual(["start", "end"]);
    expect(markers[0]?.[2]).toBe(markers[1]?.[2]);
    expect(text).toContain("row 000000");
    expect(text).toContain("LAST-ROW");
    expect(estimateToolResultTextChars(text)).toBeLessThanOrEqual(32_000);
    // Codex reads with its own native tools, which cannot open a Gateway temp file.
    expect(text).toMatch(/\[\.\.\. \d+ chars omitted\]/u);
    expect(text).not.toContain("Full output:");
  });

  it("keeps images and bounds mixed text blocks within the shared budget", async () => {
    const bridge = bridgeReturning(
      "mixed_lookup",
      {
        content: [
          { type: "text", text: "a".repeat(4_000) },
          { type: "image", data: PNG, mimeType: "image/png" },
          { type: "text", text: "你".repeat(9_000) },
        ],
        details: {},
      },
      { contextWindowTokens: 128_000, remoteWorkspaceRoot: "/remote/workspace" },
    );
    const response = await callTool(bridge, "mixed_lookup", {}, "call-mixed-weighted");

    expect(response.contentItems.map((item) => item.type)).toEqual([
      "inputText",
      "inputImage",
      "inputText",
    ]);
    expect(estimateToolResultTextChars(texts(response))).toBeLessThanOrEqual(32_000);
    expect(texts(response)).toMatch(/chars omitted/u);
  });
});
