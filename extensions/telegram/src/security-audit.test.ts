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

describe("Telegram security audit findings", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
  });

  it.each<[ResolvedTelegramAccount["config"], string, string]>([
    [{ groups: { "-100123": {} } }, "groups.allowFrom.missing", "critical"],
    [
      { groups: { "-100123": {} }, groupAllowFrom: ["@TrustedOperator"] },
      "allowFrom.invalid_entries",
      "warn",
    ],
  ])("audits group policy %j", async (config, suffix, severity) => {
    const findings = await audit(config);
    expect(
      findings.find(({ checkId }) => checkId === `channels.telegram.${suffix}`)?.severity,
    ).toBe(severity);
  });

  it.each([undefined, { text: false }])(
    "warns about invalid DM entries (commands=%j)",
    async (commands) => {
      const findings = await audit(
        { dmPolicy: "allowlist", allowFrom: ["@TrustedOperator"] },
        commands,
      );
      expect(findings).toHaveLength(1);
      expect(findings).toMatchObject([
        { checkId: "channels.telegram.allowFrom.invalid_entries", severity: "warn" },
      ]);
      expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
    },
  );
});
