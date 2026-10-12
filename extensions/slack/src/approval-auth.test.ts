import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Slack tests cover approval auth plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  getSlackApprovalApprovers,
  getSlackApprovalApproversForTeam,
  isSlackPluginApprovalAuthorizedSender,
} from "./approval-auth.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const installations: Array<ReturnType<typeof registerSlackInstallationState>> = [];

afterEach(() => {
  for (const installation of installations.splice(0)) {
    installation.release();
  }
});

function pluginRequest(
  policySubject?: PluginApprovalRequest["request"]["policySubject"],
): PluginApprovalRequest {
  return {
    id: "plugin:req-1",
    request: { title: "Plugin approval", description: "Allow access", policySubject },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("legacy Slack plugin approval sender authorization", () => {
  it("authorizes general Slack approvers from allowFrom and defaultTo", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["slack:U123OWNER", "<@U234DM>"],
          defaultTo: "user:U345DEFAULT",
          execApprovals: { enabled: true, approvers: ["user:U999EXEC"] },
        },
      },
    };

    for (const senderId of ["U123OWNER", "u123owner", "U345DEFAULT", "u345default"]) {
      expect(isSlackPluginApprovalAuthorizedSender({ cfg, senderId })).toBe(true);
    }
    for (const senderId of ["U999EXEC", "U999ATTACKER"]) {
      expect(isSlackPluginApprovalAuthorizedSender({ cfg, senderId })).toBe(false);
    }
  });

  it("keeps workspace-qualified plugin approvers scoped to their workspace", () => {
    const qualifiedApprover = "team:T11111111:user:U123OWNER";
    const qualifiedCfg = {
      channels: {
        slack: {
          allowFrom: [qualifiedApprover],
        },
      },
    };

    expect(getSlackApprovalApprovers({ cfg: qualifiedCfg })).toEqual([qualifiedApprover]);
    expect(
      isSlackPluginApprovalAuthorizedSender({
        cfg: qualifiedCfg,
        senderId: qualifiedApprover,
      }),
    ).toBe(true);
    for (const senderId of ["team:T22222222:user:U123OWNER", "U123OWNER"]) {
      expect(isSlackPluginApprovalAuthorizedSender({ cfg: qualifiedCfg, senderId })).toBe(false);
    }

    const unqualifiedCfg = {
      channels: {
        slack: {
          allowFrom: ["U123OWNER"],
        },
      },
    };
    for (const senderId of [
      "U123OWNER",
      "team:T11111111:user:U123OWNER",
      "team:T22222222:user:U123OWNER",
    ]) {
      expect(isSlackPluginApprovalAuthorizedSender({ cfg: unqualifiedCfg, senderId })).toBe(true);
    }
  });

  it("allows same-chat plugin approval when no concrete Slack approvers are configured", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["*"],
        },
      },
    };

    expect(
      isSlackPluginApprovalAuthorizedSender({
        cfg,
        senderId: "U123OWNER",
      }),
    ).toBe(true);
    expect(isSlackPluginApprovalAuthorizedSender({ cfg })).toBe(false);
  });
});

describe("isSlackPluginApprovalAuthorizedSender", () => {
  const defaultReviewer = "team:T11111111:user:U11111111";
  const pluginReviewer = "team:T11111111:user:U22222222";
  const toolReviewer = "team:T11111111:user:U33333333";
  const legacyReviewer = "team:T11111111:user:U44444444";

  it("binds raw Enterprise Grid reviewers to the request workspace", () => {
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      const otherWorkspaceReviewer = "team:T22222222:user:U22222222";
      const cfg: OpenClawConfig = {
        channels: { slack: { botToken: "xoxb-enterprise", appToken: "xapp-enterprise" } },
        approvals: {
          plugin: { slack: { approvers: ["U11111111", otherWorkspaceReviewer] } },
        },
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
      expect(
        isSlackPluginApprovalAuthorizedSender({ cfg, senderId: defaultReviewer, request }),
      ).toBe(true);
      expect(
        isSlackPluginApprovalAuthorizedSender({
          cfg,
          senderId: "team:T22222222:user:U11111111",
          request,
        }),
      ).toBe(false);
      expect(
        isSlackPluginApprovalAuthorizedSender({
          cfg,
          senderId: otherWorkspaceReviewer,
          request,
        }),
      ).toBe(false);
    } finally {
      installation.release();
    }
  });

  it("rejects a reviewer whose workspace differs from the bot account", () => {
    const defaultInstallation = registerSlackInstallationState("default", "workspace", "T11111111");
    const opsInstallation = registerSlackInstallationState("ops", "workspace", "T22222222");
    try {
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
      expect(
        isSlackPluginApprovalAuthorizedSender({
          cfg,
          accountId: "default",
          senderId: defaultReviewer,
          request,
        }),
      ).toBe(true);
      expect(
        isSlackPluginApprovalAuthorizedSender({
          cfg,
          accountId: "ops",
          senderId: defaultReviewer,
          request,
        }),
      ).toBe(false);
    } finally {
      defaultInstallation.release();
      opsInstallation.release();
    }
  });

  it("applies tool, plugin, then Agent reviewer lists with qualified IDs", () => {
    installations.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg: OpenClawConfig = {
      approvals: {
        plugin: {
          slack: {
            approvers: [defaultReviewer],
            plugins: {
              calendar: {
                approvers: [pluginReviewer],
                tools: {
                  "create%20event": { approvers: [toolReviewer] },
                },
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
    const authorized = (senderId: string, request: PluginApprovalRequest) =>
      isSlackPluginApprovalAuthorizedSender({ cfg, senderId, request });

    expect(authorized(toolReviewer, tool)).toBe(true);
    expect(authorized(pluginReviewer, tool)).toBe(false);
    expect(authorized("team:T22222222:user:U33333333", tool)).toBe(false);
    expect(authorized("U33333333", tool)).toBe(false);
    expect(authorized(pluginReviewer, siblingTool)).toBe(true);
    expect(authorized(defaultReviewer, siblingTool)).toBe(false);
    expect(authorized(defaultReviewer, otherPlugin)).toBe(true);
    expect(authorized(defaultReviewer, pluginRequest())).toBe(false);
    expect(authorized(legacyReviewer, otherPlugin)).toBe(false);
    expect(authorized(pluginReviewer, pluginRequest({ pluginKey: "calendar" }))).toBe(false);
  });

  it("distinguishes an omitted default from an explicit empty default", () => {
    installations.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg: OpenClawConfig = {
      approvals: { plugin: { slack: { plugins: { calendar: { approvers: [pluginReviewer] } } } } },
      channels: { slack: { allowFrom: [legacyReviewer] } },
    };
    const request = pluginRequest({ pluginKey: "other" });
    expect(isSlackPluginApprovalAuthorizedSender({ cfg, senderId: legacyReviewer, request })).toBe(
      true,
    );
    cfg.approvals!.plugin!.slack!.approvers = [];
    expect(isSlackPluginApprovalAuthorizedSender({ cfg, senderId: legacyReviewer, request })).toBe(
      false,
    );
  });
});
