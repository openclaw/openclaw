import { describe, expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";

describe("Slack approval setup guidance", () => {
  it.each([
    [undefined, "channels.slack"],
    ["default", "channels.slack"],
    ["work", "channels.slack.accounts.work"],
  ])("describes explicit Slack exec-approval setup for account %s", (accountId, prefix) => {
    const text = slackApprovalCapability.describeExecApprovalSetup?.({
      channel: "slack",
      channelLabel: "Slack",
      accountId,
    });

    expect(text).toContain(
      `Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\``,
    );
    expect(text).toContain(`set \`${prefix}.execApprovals.enabled\` to \`auto\` or \`true\``);
    expect(text).toContain("Unset or `false` disables native exec approval delivery.");
    expect(text).toContain("Approve it from the Web UI for now.");
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
    expect(text).not.toContain("`channels.slack.dm.allowFrom`");
  });

  it("does not reuse exec setup copy for plugin approval setup", () => {
    expect(
      slackApprovalCapability.describeExecApprovalSetup?.({
        channel: "slack",
        channelLabel: "Slack",
      }),
    ).toContain("`channels.slack.execApprovals.approvers`");
    expect(slackApprovalCapability.describePluginApprovalSetup).toBeUndefined();
  });
});
