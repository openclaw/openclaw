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

  // A whole-prefix cut below ~4.1k chars dropped the end marker. Only the body is cut now:
  // the warning, start marker and end marker stay whole, down to the smallest window a run
  // accepts (4,000 tokens, CONTEXT_WINDOW_HARD_MIN_TOKENS).
  it.each([4_000, 8_000, 16_000])(
    "keeps the whole envelope frame at the smallest budgets: %i-token window",
    async (contextWindowTokens) => {
      const wrapped = wrapExternalContent(`${"x".repeat(60_000)}\nLAST`, { source: "api" });
      const bridge = bridgeReturning("github_read", textToolResult(wrapped), {
        contextWindowTokens,
        remoteWorkspaceRoot: "/remote/workspace",
      });
      const text = texts(await callTool(bridge, "github_read", {}, "call-small"));
      const ids = [
        ...text.matchAll(/<<<(END_)?EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>/gu),
      ];

      expect(ids.map((match) => (match[1] ? "end" : "start"))).toEqual(["start", "end"]);
      expect(ids[0]?.[2]).toBe(ids[1]?.[2]);
      const frameEnd = wrapped.indexOf("\n---\n") + 5;
      expect(text.slice(0, frameEnd).replace(/id="[a-f0-9]{16}"/u, "")).toBe(
        wrapped.slice(0, frameEnd).replace(/id="[a-f0-9]{16}"/u, ""),
      );
      expect(text).toMatch(/chars omitted/u);
      expect(text).toMatch(/\nLAST\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>$/u);
    },
  );

  // An image takes 16,000 of a 16,700-char context share: a plain head would be shorter than
  // the warning and start marker. The envelope's frame is reserved, so only the body shrinks.
  it("keeps the whole envelope frame when an image leaves little room", async () => {
    const wrapped = wrapExternalContent(`${"x".repeat(60_000)}\nLAST`, { source: "api" });
    const bridge = bridgeReturning(
      "github_read",
      {
        content: [
          { type: "text", text: wrapped },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
        details: {},
      },
      { contextWindowTokens: 16_700, remoteWorkspaceRoot: "/remote/workspace" },
    );
    const text = texts(await callTool(bridge, "github_read", {}, "call-image-room"));
    const frameEnd = wrapped.indexOf("\n---\n") + 5;

    expect(text.slice(0, frameEnd).replace(/id="[a-f0-9]{16}"/u, "")).toBe(
      wrapped.slice(0, frameEnd).replace(/id="[a-f0-9]{16}"/u, ""),
    );
    expect(text).toMatch(/\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>$/u);
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
