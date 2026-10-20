import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  resolvePreparedSandboxRuntimeStatus,
} from "./sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: toolPolicyAuditInfo }),
}));

function config(
  global: ToolAllowDenyPolicyConfig,
  agent?: ToolAllowDenyPolicyConfig,
  mode: "all" | "non-main" = "all",
): OpenClawConfig {
  return {
    agents: {
      defaults: { sandbox: { mode, scope: "agent" } },
      entries: { work: { workspace: "~/openclaw-work", tools: { sandbox: { tools: agent } } } },
    },
    tools: { sandbox: { tools: global } },
  };
}

function blockedMessage(audit?: boolean) {
  const cfg = config({ deny: ["browser"] }, undefined, "non-main");
  const sessionKey = "agent:main:mobilechat:group:g1";
  return formatSandboxToolPolicyBlockedMessage({
    cfg,
    sessionKey,
    toolName: "browser",
    audit,
    preparedRuntimeStatus: resolvePreparedSandboxRuntimeStatus({
      cfg,
      sessionKey,
      preparedSessionEntry: null,
    }),
  });
}

describe("sandbox explain helpers", () => {
  beforeEach(() => {
    toolPolicyAuditInfo.mockClear();
  });

  it("prefers agent overrides > global > defaults (sandbox tool policy)", () => {
    const cfg = config({ allow: ["read"], deny: ["browser"] }, { allow: ["write"] });

    const lists = { allow: ["write", "view_image"], deny: ["browser"] };
    expect(resolveSandboxConfigForAgent(cfg, "work").tools).toMatchObject(lists);
    expect(resolveSandboxToolPolicyForAgent(cfg, "work")).toMatchObject({
      ...lists,
      sources: { allow: { source: "agent" }, deny: { source: "global" } },
    });
  });

  it("expands group tool shorthands inside sandbox tool policy", () => {
    const cfg = config({}, { allow: ["group:memory", "group:fs"] });

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy.allow).toEqual([
      "memory_search",
      "memory_get",
      "personal_instructions",
      "ls",
      "read",
      "write",
      "edit",
      "apply_patch",
      "view_image",
    ]);
  });

  it("denies still win after group expansion", () => {
    const cfg = config({ allow: ["group:memory"], deny: ["memory_get"] });

    const policy = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(policy.allow).toContain("memory_search");
    expect(policy.allow).toContain("memory_get");
    expect(policy.deny).toContain("memory_get");
  });

  it("includes config key paths + main-session hint for non-main mode", () => {
    const msg = blockedMessage(true);
    expect(msg).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(msg).toContain("mode=non-main");
    expect(msg).toContain("tools.sandbox.tools.deny");
    expect(msg).toContain("agents.defaults.sandbox.mode=off");
    expect(msg).toContain("Use the agent main session instead of a non-main session.");
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "sandbox tool policy blocked browser via tools.sandbox.tools.deny; matched browser",
      {
        tool: "browser",
        ruleKind: "deny",
        ruleSource: "global",
        configKey: "tools.sandbox.tools.deny",
        matchedRule: "browser",
        sandboxMode: "non-main",
      },
    );
  });

  it("does not audit sandbox tool-policy formatting unless requested", () => {
    const msg = blockedMessage();
    expect(msg).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });
});
