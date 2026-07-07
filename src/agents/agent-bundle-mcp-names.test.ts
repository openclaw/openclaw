/** Tests MCP server/tool name sanitization, truncation, and collision handling. */
import { describe, expect, it } from "vitest";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  sanitizeServerName,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";

describe("agent bundle MCP names", () => {
  it("sanitizes and disambiguates server names", () => {
    const usedNames = new Set<string>();
    expect(sanitizeServerName("vigil-harbor", usedNames)).toBe("vigil-harbor");
    expect(sanitizeServerName("vigil:harbor", usedNames)).toBe("vigil-harbor-2");
  });

  it("keeps server and tool fragments provider-safe when they start with digits", () => {
    const usedNames = new Set<string>();
    const serverName = sanitizeServerName("12306", usedNames);
    expect(serverName).toBe("mcp-12306");
    expect(buildSafeToolName({ serverName, toolName: "2024-query", reservedNames: new Set() }))
      .toBe(`mcp-12306${TOOL_NAME_SEPARATOR}tool-2024-query`);
  });

  it("builds provider-safe tool names and avoids collisions", () => {
    const reservedNames = normalizeReservedToolNames(["memory__status"]);
    expect(buildSafeToolName({ serverName: "memory", toolName: "status", reservedNames }))
      .toBe(`memory${TOOL_NAME_SEPARATOR}status-2`);
  });

  it("truncates overlong tool names while keeping the server prefix", () => {
    const safeToolName = buildSafeToolName({
      serverName: "memory", toolName: "x".repeat(200), reservedNames: new Set(),
    });
    expect(safeToolName.startsWith(`memory${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(safeToolName.length).toBeLessThanOrEqual(64);
  });

  it("preserves emoji surrogate pairs at tool name truncation boundaries", () => {
    const safeToolName = buildSafeToolName({
      serverName: "srv",
      toolName: "a".repeat(58) + "🧠" + "b".repeat(30),
      reservedNames: new Set(),
    });
    expect(safeToolName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(safeToolName).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(safeToolName.length).toBeLessThanOrEqual(64);
  });

  it("preserves multi-byte emoji at server name truncation boundaries", () => {
    const usedNames = new Set<string>();
    const serverName = sanitizeServerName("a".repeat(29) + "🧠" + "b".repeat(10), usedNames);
    expect(serverName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(serverName).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(serverName.length).toBeLessThanOrEqual(30);
  });
});
