/** Tests MCP server/tool name sanitization, truncation, and collision handling. */
import { describe, expect, it } from "vitest";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  sanitizeNodeIdFragment,
  sanitizeServerName,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";

describe("agent bundle MCP names", () => {
  it.each([
    { value: "", expected: "node" },
    { value: "123-node", expected: "node_123_node" },
    { value: "a".repeat(40), expected: "a".repeat(32) },
  ])("sanitizes node ID fragment $value", ({ value, expected }) => {
    expect(sanitizeNodeIdFragment(value)).toBe(expected);
  });

  it("sanitizes and disambiguates server names", () => {
    const usedNames = new Set<string>();

    expect(sanitizeServerName("vigil-harbor", usedNames)).toBe("vigil-harbor");
    expect(sanitizeServerName("vigil:harbor", usedNames)).toBe("vigil-harbor-2");
  });

  it("keeps server and tool fragments provider-safe when they start with digits", () => {
    const usedNames = new Set<string>();
    const serverName = sanitizeServerName("12306", usedNames);

    expect(serverName).toBe("mcp-12306");
    expect(
      buildSafeToolName({
        serverName,
        toolName: "2024-query",
        reservedNames: new Set(),
      }),
    ).toBe(`mcp-12306${TOOL_NAME_SEPARATOR}tool-2024-query`);
  });

  it("builds provider-safe tool names and avoids collisions", () => {
    const reservedNames = normalizeReservedToolNames(["memory__status"]);

    const safeToolName = buildSafeToolName({
      serverName: "memory",
      toolName: "status",
      reservedNames,
    });
    expect(safeToolName).toBe(`memory${TOOL_NAME_SEPARATOR}status-2`);
  });
});
