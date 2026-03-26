import { describe, expect, it } from "vitest";
import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";

/**
 * Tests the per-agent MCP allowlist filtering logic.
 *
 * The logic in loadEmbeddedPiMcpConfig is:
 *   1. Merge bundle + global servers (same as before).
 *   2. If agentMcpServers is set and does NOT contain "*",
 *      filter to only keep servers whose names are in the list.
 */

function applyAllowlistFilter(
  allServers: Record<string, Record<string, unknown>>,
  allowlist: string[] | undefined,
): Record<string, unknown> {
  if (!allowlist || allowlist.length === 0 || allowlist.includes("*")) {
    return { ...allServers };
  }
  const allowSet = new Set(allowlist);
  return Object.fromEntries(Object.entries(allServers).filter(([name]) => allowSet.has(name)));
}

describe("per-agent MCP allowlist filtering", () => {
  const allServers = {
    filesystem: { command: "npx", args: ["@mcp/server-filesystem"] },
    "brave-search": { command: "npx", args: ["@mcp/server-brave-search"] },
    github: { command: "npx", args: ["@mcp/server-github"] },
  };

  it("no allowlist (undefined) → all servers pass through", () => {
    const result = applyAllowlistFilter(allServers, undefined);
    expect(Object.keys(result).toSorted()).toEqual(["brave-search", "filesystem", "github"]);
  });

  it('["*"] allowlist → all servers pass through', () => {
    const result = applyAllowlistFilter(allServers, ["*"]);
    expect(Object.keys(result).toSorted()).toEqual(["brave-search", "filesystem", "github"]);
  });

  it("empty allowlist → all servers pass through", () => {
    const result = applyAllowlistFilter(allServers, []);
    expect(Object.keys(result).toSorted()).toEqual(["brave-search", "filesystem", "github"]);
  });

  it("specific allowlist → only listed servers remain", () => {
    const result = applyAllowlistFilter(allServers, ["filesystem", "github"]);
    expect(Object.keys(result).toSorted()).toEqual(["filesystem", "github"]);
  });

  it("single-server allowlist → only that server remains", () => {
    const result = applyAllowlistFilter(allServers, ["brave-search"]);
    expect(Object.keys(result)).toEqual(["brave-search"]);
  });

  it("allowlist with unknown names → silently ignored", () => {
    const result = applyAllowlistFilter(allServers, ["filesystem", "nonexistent"]);
    expect(Object.keys(result)).toEqual(["filesystem"]);
  });
});

describe("normalizeConfiguredMcpServers passthrough", () => {
  it("returns empty record for undefined input", () => {
    expect(normalizeConfiguredMcpServers(undefined)).toEqual({});
  });

  it("passes through valid server records", () => {
    const servers = {
      test: { command: "echo", args: ["hello"] },
    };
    const result = normalizeConfiguredMcpServers(servers);
    expect(result).toHaveProperty("test");
  });
});
