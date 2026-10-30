import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  resolvePreparedSandboxRuntimeStatus,
} from "./sandbox/runtime-status.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";

const toolPolicyAuditInfo = vi.hoisted(() => vi.fn());

// mock-isolation: Observe audit logging without touching the real subsystem logger.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: toolPolicyAuditInfo }),
}));

function sandboxConfig(
  tools: ToolAllowDenyPolicyConfig | undefined,
  agentTools?: ToolAllowDenyPolicyConfig,
  mode: "all" | "non-main" = "all",
): OpenClawConfig {
  return {
    agents: {
      defaults: { sandbox: { mode, scope: "agent" } },
      entries: agentTools ? { work: { tools: { sandbox: { tools: agentTools } } } } : undefined,
    },
    tools: tools ? { sandbox: { tools } } : undefined,
  };
}

describe("sandbox explain helpers", () => {
  beforeEach(() => {
    toolPolicyAuditInfo.mockClear();
  });

  it("prefers agent groups over global allows while preserving global denies", () => {
    const cfg = sandboxConfig(
      { allow: ["browser"], deny: ["memory_get"] },
      { allow: ["group:memory", "group:fs"] },
    );

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy.allow).toEqual(expect.arrayContaining(["memory_search", "memory_get", "read"]));
    expect(policy.allow).not.toContain("browser");
    expect(policy.deny).toEqual(["memory_get"]);
    expect(policy.sources).toMatchObject({
      allow: { source: "agent" },
      deny: { source: "global" },
    });
    expect(isToolAllowed(policy, "memory_get")).toBe(false);
  });

  it.each([undefined, true])("explains non-main policy blocks (audit: %s)", (audit) => {
    const cfg = sandboxConfig({ deny: ["browser"] }, undefined, "non-main");
    const sessionKey = "agent:main:mobilechat:group:g1";
    const msg = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      preparedRuntimeStatus: resolvePreparedSandboxRuntimeStatus({
        cfg,
        sessionKey,
        preparedSessionEntry: null,
      }),
      toolName: "browser",
      audit,
    });
    for (const text of [
      'Tool "browser" blocked by sandbox tool policy',
      "mode=non-main",
      "tools.sandbox.tools.deny",
      "agents.defaults.sandbox.mode=off",
      "Use the agent main session instead of a non-main session.",
    ]) {
      expect(msg).toContain(text);
    }
    if (!audit) {
      expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
      return;
    }
    expect(toolPolicyAuditInfo.mock.calls[0]?.[1]).toMatchObject({
      tool: "browser",
      ruleKind: "deny",
      ruleSource: "global",
      configKey: "tools.sandbox.tools.deny",
    });
  });
});
