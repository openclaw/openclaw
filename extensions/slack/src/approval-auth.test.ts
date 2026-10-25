import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  getSlackApprovalApprovers,
  getSlackApprovalApproversForTeam,
  isSlackPluginApprovalAuthorizedSender,
} from "./approval-auth.js";
import { buildPluginRequest, useSlackInstallations } from "./approval-native.test-support.js";

const install = useSlackInstallations();
type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
const slackConfig = (slack: SlackConfig): OpenClawConfig => ({ channels: { slack } });
const authorized = isSlackPluginApprovalAuthorizedSender;

function pluginRequest(
  policySubject?: PluginApprovalRequest["request"]["policySubject"],
): PluginApprovalRequest {
  return buildPluginRequest({ policySubject });
}

describe("legacy Slack plugin approval sender authorization", () => {
  it("authorizes general Slack approvers from allowFrom and defaultTo", () => {
    const cfg = slackConfig({
      allowFrom: ["slack:U123OWNER", "<@U234DM>"],
      defaultTo: "user:U345DEFAULT",
      execApprovals: { enabled: true, approvers: ["user:U999EXEC"] },
    });

    for (const senderId of ["U123OWNER", "u123owner", "U345DEFAULT", "u345default"]) {
      expect(authorized({ cfg, senderId })).toBe(true);
    }
    for (const senderId of ["U999EXEC", "U999ATTACKER"]) {
      expect(authorized({ cfg, senderId })).toBe(false);
    }
  });

  it("keeps workspace-qualified plugin approvers scoped to their workspace", () => {
    const qualifiedApprover = "team:T11111111:user:U123OWNER";
    const qualifiedCfg = slackConfig({ allowFrom: [qualifiedApprover] });

    expect(getSlackApprovalApprovers({ cfg: qualifiedCfg })).toEqual([qualifiedApprover]);
    expect(authorized({ cfg: qualifiedCfg, senderId: qualifiedApprover })).toBe(true);
    for (const senderId of ["team:T22222222:user:U123OWNER", "U123OWNER"]) {
      expect(authorized({ cfg: qualifiedCfg, senderId })).toBe(false);
    }

    const unqualifiedCfg = slackConfig({ allowFrom: ["U123OWNER"] });
    for (const senderId of [
      "U123OWNER",
      "team:T11111111:user:U123OWNER",
      "team:T22222222:user:U123OWNER",
    ]) {
      expect(authorized({ cfg: unqualifiedCfg, senderId })).toBe(true);
    }
  });

  it("allows same-chat plugin approval when no concrete Slack approvers are configured", () => {
    const cfg = slackConfig({ allowFrom: ["*"] });

    expect(authorized({ cfg, senderId: "U123OWNER" })).toBe(true);
    expect(authorized({ cfg })).toBe(false);
  });
});

describe("isSlackPluginApprovalAuthorizedSender", () => {
  const defaultReviewer = "team:T11111111:user:U11111111";
  const pluginReviewer = "team:T11111111:user:U22222222";
  const toolReviewer = "team:T11111111:user:U33333333";
  const legacyReviewer = "team:T11111111:user:U44444444";

  it("binds raw Enterprise Grid reviewers to the request workspace", () => {
    install("default", "enterprise");
    const otherWorkspaceReviewer = "team:T22222222:user:U22222222";
    const cfg: OpenClawConfig = {
      channels: { slack: { botToken: "xoxb-enterprise", appToken: "xapp-enterprise" } },
      approvals: { plugin: { slack: { approvers: ["U11111111", otherWorkspaceReviewer] } } },
    };
    const base = pluginRequest({ pluginKey: "diffs", tool: "diffs" });
    const request: PluginApprovalRequest = {
      ...base,
      request: {
        ...base.request,
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
        turnSourceTo: "team:T11111111:channel:C11111111",
      },
    };
    expect(getSlackApprovalApproversForTeam({ cfg, request, teamId: "T11111111" })).toEqual([
      "U11111111",
    ]);
    expect(authorized({ cfg, senderId: defaultReviewer, request })).toBe(true);
    expect(authorized({ cfg, senderId: "team:T22222222:user:U11111111", request })).toBe(false);
    expect(authorized({ cfg, senderId: otherWorkspaceReviewer, request })).toBe(false);
  });

  it("rejects a reviewer whose workspace differs from the bot account", () => {
    install("default", "workspace", "T11111111");
    install("ops", "workspace", "T22222222");
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          accounts: {
            default: { botToken: "xoxb-default", appToken: "xapp-default" },
            ops: { botToken: "xoxb-ops", appToken: "xapp-ops" },
          },
        },
      },
      approvals: { plugin: { slack: { approvers: [defaultReviewer] } } },
    };
    const request = pluginRequest({ pluginKey: "diffs", tool: "diffs" });
    const params = { cfg, senderId: defaultReviewer, request };
    expect(authorized({ ...params, accountId: "default" })).toBe(true);
    expect(authorized({ ...params, accountId: "ops" })).toBe(false);
  });

  it("applies tool, plugin, then Agent reviewer lists with qualified IDs", () => {
    install("default", "workspace", "T11111111");
    const cfg: OpenClawConfig = {
      approvals: {
        plugin: {
          slack: {
            approvers: [defaultReviewer],
            plugins: {
              calendar: {
                approvers: [pluginReviewer],
                tools: { "create%20event": { approvers: [toolReviewer] } },
              },
            },
          },
        },
      },
      channels: { slack: { allowFrom: [legacyReviewer] } },
    };
    const tool = pluginRequest({ pluginKey: "calendar", tool: "create event" });
    const siblingTool = pluginRequest({ pluginKey: "calendar", tool: "delete event" });
    const otherPlugin = pluginRequest({ pluginKey: "other" });
    const approves = (senderId: string, request: PluginApprovalRequest) =>
      authorized({ cfg, senderId, request });

    expect(approves(toolReviewer, tool)).toBe(true);
    expect(approves(pluginReviewer, tool)).toBe(false);
    expect(approves("team:T22222222:user:U33333333", tool)).toBe(false);
    expect(approves("U33333333", tool)).toBe(false);
    expect(approves(pluginReviewer, siblingTool)).toBe(true);
    expect(approves(defaultReviewer, siblingTool)).toBe(false);
    expect(approves(defaultReviewer, otherPlugin)).toBe(true);
    expect(approves(defaultReviewer, pluginRequest())).toBe(false);
    expect(approves(legacyReviewer, otherPlugin)).toBe(false);
    expect(approves(pluginReviewer, pluginRequest({ pluginKey: "calendar" }))).toBe(false);
  });

  it("distinguishes an omitted default from an explicit empty default", () => {
    install("default", "workspace", "T11111111");
    const cfg: OpenClawConfig = {
      approvals: { plugin: { slack: { plugins: { calendar: { approvers: [pluginReviewer] } } } } },
      channels: { slack: { allowFrom: [legacyReviewer] } },
    };
    const request = pluginRequest({ pluginKey: "other" });
    expect(authorized({ cfg, senderId: legacyReviewer, request })).toBe(true);
    cfg.approvals!.plugin!.slack!.approvers = [];
    expect(authorized({ cfg, senderId: legacyReviewer, request })).toBe(false);
  });
});
