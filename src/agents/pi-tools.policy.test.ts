import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { filterToolsByPolicy, isToolAllowedByPolicyName } from "./pi-tools.policy.js";

function createStubTool(name: string): AgentTool<unknown, unknown> {
  return {
    name,
    label: name,
    description: "",
    parameters: {},
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe("pi-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when exec is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["exec"] })).toBe(true);
  });

  describe("patterns containing slashes (greedy regex safety)", () => {
    it("allows a tool name with slashes when pattern uses wildcard prefix", () => {
      // e.g. allow: ["mcp/myserver/*"] should match "mcp/myserver/tool_a"
      expect(isToolAllowedByPolicyName("mcp/myserver/tool_a", { allow: ["mcp/myserver/*"] })).toBe(
        true,
      );
    });

    it("does not over-match across unrelated slash-separated segments", () => {
      // "mcp/other/tool_a" should NOT match "mcp/myserver/*"
      expect(isToolAllowedByPolicyName("mcp/other/tool_a", { allow: ["mcp/myserver/*"] })).toBe(
        false,
      );
    });

    it("denies a tool name with slashes via wildcard deny pattern", () => {
      expect(isToolAllowedByPolicyName("mcp/myserver/tool_a", { deny: ["mcp/myserver/*"] })).toBe(
        false,
      );
    });

    it("matches exact slash-containing names without wildcards", () => {
      expect(
        isToolAllowedByPolicyName("mcp/myserver/tool_a", { allow: ["mcp/myserver/tool_a"] }),
      ).toBe(true);
      expect(
        isToolAllowedByPolicyName("mcp/myserver/tool_b", { allow: ["mcp/myserver/tool_a"] }),
      ).toBe(false);
    });

    it("handles wildcard in the middle of a slash-separated pattern", () => {
      // "mcp/*/tool_a" should match any server name in the middle
      expect(isToolAllowedByPolicyName("mcp/server1/tool_a", { allow: ["mcp/*/tool_a"] })).toBe(
        true,
      );
      expect(isToolAllowedByPolicyName("mcp/server2/tool_a", { allow: ["mcp/*/tool_a"] })).toBe(
        true,
      );
      // but not a different tool name
      expect(isToolAllowedByPolicyName("mcp/server1/tool_b", { allow: ["mcp/*/tool_a"] })).toBe(
        false,
      );
    });

    it("handles multiple wildcards in slash patterns", () => {
      expect(isToolAllowedByPolicyName("mcp/srv/deep/tool", { allow: ["mcp/*/deep/*"] })).toBe(
        true,
      );
      expect(isToolAllowedByPolicyName("mcp/srv/shallow/tool", { allow: ["mcp/*/deep/*"] })).toBe(
        false,
      );
    });
  });
});
