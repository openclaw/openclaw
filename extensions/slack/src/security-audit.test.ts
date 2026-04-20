import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { collectSlackSecurityAuditFindings } from "./security-audit.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createSlackAccount(config: NonNullable<OpenClawConfig["channels"]>["slack"]) {
  return {
    accountId: "default",
    enabled: true,
    botToken: "xoxb-test",
    botTokenSource: "config",
    appTokenSource: "config",
    config,
  } as ResolvedSlackAccount;
}

describe("Slack security audit findings", () => {
  it("flags slash commands without a channel users allowlist", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          groupPolicy: "open",
          slashCommand: { enabled: true },
        },
      },
    };

    readChannelAllowFromStoreMock.mockResolvedValue([]);
    const findings = await collectSlackSecurityAuditFindings({
      cfg,
      account: createSlackAccount(cfg.channels!.slack),
      accountId: "default",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.slack.commands.slash.no_allowlists",
          severity: "warn",
        }),
      ]),
    );
  });

  it("flags slash commands when access-group enforcement is disabled", async () => {
    const cfg: OpenClawConfig = {
      commands: { useAccessGroups: false },
      channels: {
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          groupPolicy: "open",
          slashCommand: { enabled: true },
        },
      },
    };

    readChannelAllowFromStoreMock.mockResolvedValue([]);
    const findings = await collectSlackSecurityAuditFindings({
      cfg,
      account: createSlackAccount(cfg.channels!.slack),
      accountId: "default",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.slack.commands.slash.useAccessGroups_off",
          severity: "critical",
        }),
      ]),
    );
  });
});
