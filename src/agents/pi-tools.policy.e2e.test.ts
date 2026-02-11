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

  describe("scoped exec patterns", () => {
    it("allows exec when command matches scoped pattern", () => {
      const policy = { allow: ["exec:gog calendar freebusy*"] };
      expect(
        isToolAllowedByPolicyName("exec", policy, "gog calendar freebusy --from=2026-01-01"),
      ).toBe(true);
    });

    it("denies exec when command does not match scoped pattern", () => {
      const policy = { allow: ["exec:gog calendar freebusy*"] };
      expect(isToolAllowedByPolicyName("exec", policy, "rm -rf /")).toBe(false);
    });

    it("denies exec when no command is provided but scoped pattern exists", () => {
      const policy = { allow: ["exec:gog calendar*"] };
      expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    });

    it("allows exec with exact command match", () => {
      const policy = { allow: ["exec:ls -la"] };
      expect(isToolAllowedByPolicyName("exec", policy, "ls -la")).toBe(true);
      expect(isToolAllowedByPolicyName("exec", policy, "ls -la /etc")).toBe(false);
    });

    it("scoped exec pattern overrides general deny", () => {
      const policy = { allow: ["exec:gog calendar*"], deny: ["exec"] };
      expect(isToolAllowedByPolicyName("exec", policy, "gog calendar events")).toBe(true);
      expect(isToolAllowedByPolicyName("exec", policy, "rm -rf /")).toBe(false);
    });

    it("allows non-exec tools normally when scoped exec patterns exist", () => {
      const policy = { allow: ["exec:gog calendar*", "web_search"] };
      expect(isToolAllowedByPolicyName("web_search", policy)).toBe(true);
      expect(isToolAllowedByPolicyName("read", policy)).toBe(false);
    });

    it("treats exec:* as allow-all for exec", () => {
      const policy = { allow: ["exec:*"] };
      expect(isToolAllowedByPolicyName("exec", policy, "anything")).toBe(true);
    });
  });
});
