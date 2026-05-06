import { describe, expect, it } from "vitest";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  sanitizeServerName,
  TOOL_NAME_SEPARATOR,
} from "./pi-bundle-mcp-names.js";

describe("pi bundle MCP names", () => {
  it("sanitizes and disambiguates server names", () => {
    const usedNames = new Set<string>();

    expect(sanitizeServerName("vigil-harbor", usedNames)).toBe("vigil-harbor");
    expect(sanitizeServerName("vigil:harbor", usedNames)).toBe("vigil-harbor-2");
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

  it("uses the bundle server name for Link MCP tools", () => {
    const usedServerNames = new Set<string>();
    const serverName = sanitizeServerName("link", usedServerNames);

    expect(
      buildSafeToolName({
        serverName,
        toolName: "auth_login",
        reservedNames: new Set(),
      }),
    ).toBe(`link${TOOL_NAME_SEPARATOR}auth_login`);
    expect(
      buildSafeToolName({
        serverName,
        toolName: "spend-request_create",
        reservedNames: new Set(),
      }),
    ).toBe(`link${TOOL_NAME_SEPARATOR}spend-request_create`);
  });

  it("truncates overlong tool names while keeping the server prefix", () => {
    const safeToolName = buildSafeToolName({
      serverName: "memory",
      toolName: "x".repeat(200),
      reservedNames: new Set(),
    });

    expect(safeToolName.startsWith(`memory${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(safeToolName.length).toBeLessThanOrEqual(64);
  });
});
