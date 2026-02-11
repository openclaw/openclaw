import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicies,
  isToolAllowedByPolicyName,
  resolveEffectiveToolPolicy,
} from "./pi-tools.policy.js";

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

  it("inherits agents.list[].tools policy for sub-agent sessions by default", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              deny: ["read"],
            },
          },
        ],
      },
    };

    const resolved = resolveEffectiveToolPolicy({
      config,
      sessionKey: "agent:main:subagent:abc",
    });
    expect(isToolAllowedByPolicies("read", [resolved.agentPolicy])).toBe(false);
  });

  it("uses agents.list[].subagents.tools policy for sub-agent sessions when configured", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              deny: ["read"],
            },
            subagents: {
              tools: {
                allow: ["*"],
              },
            },
          },
        ],
      },
    };

    const mainResolved = resolveEffectiveToolPolicy({
      config,
      sessionKey: "agent:main:main",
    });
    expect(isToolAllowedByPolicies("read", [mainResolved.agentPolicy])).toBe(false);

    const subResolved = resolveEffectiveToolPolicy({
      config,
      sessionKey: "agent:main:subagent:abc",
    });
    expect(isToolAllowedByPolicies("read", [subResolved.agentPolicy])).toBe(true);
  });

  it("does not inherit agents.list[].tools.byProvider when sub-agent tools override is configured", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              byProvider: {
                openai: {
                  deny: ["read"],
                },
              },
            },
            subagents: {
              tools: {
                allow: ["*"],
              },
            },
          },
        ],
      },
    };

    const mainResolved = resolveEffectiveToolPolicy({
      config,
      sessionKey: "agent:main:main",
      modelProvider: "openai",
    });
    expect(isToolAllowedByPolicies("read", [mainResolved.agentProviderPolicy])).toBe(false);

    const subResolved = resolveEffectiveToolPolicy({
      config,
      sessionKey: "agent:main:subagent:abc",
      modelProvider: "openai",
    });
    expect(subResolved.agentProviderPolicy).toBeUndefined();
  });
});
