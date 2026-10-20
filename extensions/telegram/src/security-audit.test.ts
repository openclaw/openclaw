import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { collectTelegramSecurityAuditFindings } from "./security-audit.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function audit(config: ResolvedTelegramAccount["config"], commands?: OpenClawConfig["commands"]) {
  const account: ResolvedTelegramAccount = {
    accountId: "default",
    enabled: true,
    token: "t",
    tokenSource: "config",
    tokenStatus: "available",
    config: { enabled: true, botToken: "t", groupPolicy: "allowlist", ...config },
  };
  return collectTelegramSecurityAuditFindings({
    cfg: { channels: { telegram: account.config }, commands },
    account,
    accountId: "default",
  });
}

function expectFindingSeverity(
  findings: Awaited<ReturnType<typeof collectTelegramSecurityAuditFindings>>,
  checkId: string,
  severity: string,
): void {
  const finding = findings.find((entry) => entry.checkId === checkId);
  expect(finding?.severity).toBe(severity);
}

describe("Telegram security audit findings", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
    readChannelAllowFromStoreMock.mockResolvedValue([]);
  });

  it("flags group commands without a sender allowlist", async () => {
    const findings = await audit({ groups: { "-100123": {} } });
    expectFindingSeverity(findings, "channels.telegram.groups.allowFrom.missing", "critical");
  });

  it("warns when allowFrom entries are non-numeric legacy @username configs", async () => {
    const findings = await audit({
      groupAllowFrom: ["@TrustedOperator"],
      groups: { "-100123": {} },
    });

    expectFindingSeverity(findings, "channels.telegram.allowFrom.invalid_entries", "warn");
  });

  it.each([undefined, { text: false }])(
    "warns about invalid DM entries (commands=%j)",
    async (commands) => {
      const findings = await audit(
        { dmPolicy: "allowlist", allowFrom: ["@TrustedOperator"] },
        commands,
      );
      expect(findings).toHaveLength(1);
      expectFindingSeverity(findings, "channels.telegram.allowFrom.invalid_entries", "warn");
      expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
    },
  );
});
