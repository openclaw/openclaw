import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { collectDiscordSecurityAuditFindings } from "./security-audit.js";

type DiscordAccountConfig = ResolvedDiscordAccount["config"];
const memberLists = (users: string[], channelUsers: string[]) => ({
  "123": { users, channels: { general: { users: channelUsers } } },
});

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function guildConfig(
  guild: NonNullable<DiscordAccountConfig["guilds"]>[string],
  key = "team-space",
): DiscordAccountConfig {
  return { groupPolicy: "allowlist", guilds: { [key]: guild } };
}

async function collectFindings(params: {
  cfg?: OpenClawConfig;
  config: DiscordAccountConfig;
  accountId?: string;
  orderedAccountIds?: string[];
  hasExplicitAccountPath?: boolean;
  storeAllowFrom?: string[];
}) {
  readChannelAllowFromStoreMock.mockResolvedValue(params.storeAllowFrom ?? []);
  return await collectDiscordSecurityAuditFindings({
    cfg: params.cfg ?? { channels: { discord: params.config } },
    account: {
      accountId: params.accountId ?? "default",
      enabled: true,
      token: "t",
      tokenSource: "config",
      tokenStatus: "available",
      config: params.config,
    },
    accountId: params.accountId ?? "default",
    orderedAccountIds: params.orderedAccountIds ?? ["default"],
    hasExplicitAccountPath: params.hasExplicitAccountPath ?? false,
  });
}

describe("Discord security audit findings", () => {
  it.each([
    ["whole-guild wildcard", guildConfig({}, "*"), "*"],
    [
      "wildcard channel",
      guildConfig({ channels: { "*": { enabled: true } } }),
      "team-space.channels.*",
    ],
    [
      "inherited member restriction",
      guildConfig({ users: ["123456789012345678"], channels: { general: { enabled: true } } }),
      undefined,
    ],
    ["wildcard users", guildConfig({ users: ["*"] }), "team-space"],
    ["wildcard roles", guildConfig({ roles: ["*"] }), "team-space"],
    ["disabled channel", guildConfig({ channels: { general: { enabled: false } } }), undefined],
  ] as const)("audits %s", async (_name, config, path) => {
    const finding = (await collectFindings({ config })).find(
      (entry) => entry.checkId === "channels.discord.allowlisted_groups.broad_members",
    );
    if (path === undefined) {
      expect(finding).toBeUndefined();
    } else {
      expect(finding).toMatchObject({
        severity: "warn",
        detail: expect.stringContaining(`channels.discord.guilds.${path}`),
      });
    }
  });

  it("uses the account-specific path for broad member warnings", async () => {
    const config = guildConfig({}, "work");
    const findings = await collectFindings({
      cfg: { channels: { discord: { accounts: { work: config } } } },
      config,
      accountId: "work",
      orderedAccountIds: ["default", "work"],
      hasExplicitAccountPath: true,
    });
    const finding = findings.find(
      (entry) => entry.checkId === "channels.discord.allowlisted_groups.broad_members",
    );
    expect(finding?.detail).toContain("channels.discord.accounts.work.guilds.work");
    expect(finding?.severity).toBe("warn");
  });

  it.each([
    ["missing", undefined, undefined, true],
    ["legacy", { allowFrom: ["387380367612706819"] }, undefined, false],
    ["canonical empty overrides legacy", { allowFrom: ["387380367612706819"] }, [], true],
    ["canonical", undefined, ["387380367612706819"], false],
  ] as const)(
    "audits %s native-command allowlists",
    async (_name, dm, allowFrom, expectFinding) => {
      // Exercise legacy dm.allowFrom input, which is no longer in the config schema.
      const config = {
        ...guildConfig({ channels: { general: { enabled: true } } }, "123"),
        dm,
        allowFrom,
      } as unknown as DiscordAccountConfig;
      const findings = await collectFindings({
        cfg: { commands: { native: true }, channels: { discord: config } },
        config,
      });

      expect(
        findings.some(
          (finding) => finding.checkId === "channels.discord.commands.native.no_allowlists",
        ),
      ).toBe(expectFinding);
    },
  );

  it.each([
    {
      name: "warns when Discord allowlists contain name-based entries",
      config: {
        allowFrom: ["Alice#1234", " Alice#1234 ", "second.operator", "<@123456789012345678>"],
        guilds: memberLists(["trusted.operator"], ["987654321098765432", "security-team"]),
      } satisfies DiscordAccountConfig,
      storeAllowFrom: ["team.owner"],
      expectNameBasedSeverity: "warn",
      detailIncludes: [
        "Found 5 name/tag entries",
        "channels.discord.allowFrom (2)",
        "channels.discord.guilds.123.users (1)",
        "channels.discord.guilds.123.channels.general.users (1)",
        "Discord pairing store (1)",
      ],
      detailExcludes: [
        "Alice#1234",
        "second.operator",
        "trusted.operator",
        "security-team",
        "team.owner",
        "<@123456789012345678>",
        "987654321098765432",
      ],
    },
    {
      name: "marks Discord name-based allowlists as break-glass when dangerous matching is enabled",
      config: {
        dangerouslyAllowNameMatching: true,
        allowFrom: ["Alice#1234"],
      } satisfies DiscordAccountConfig,
      expectNameBasedSeverity: "info",
      detailIncludes: ["out-of-scope"],
      detailExcludes: ["Alice#1234"],
    },
    {
      name: "audits name-based allowlists on non-default Discord accounts",
      accountId: "beta",
      orderedAccountIds: ["alpha", "beta"],
      hasExplicitAccountPath: true,
      config: { allowFrom: ["Alice#1234"] } satisfies DiscordAccountConfig,
      expectNameBasedSeverity: "warn",
      detailIncludes: ["channels.discord.accounts.beta.allowFrom (1)"],
      detailExcludes: ["Alice#1234"],
    },
    {
      name: "does not warn when Discord allowlists use ID-style entries only",
      config: {
        allowFrom: [
          "123456789012345678",
          "<@223456789012345678>",
          "user:323456789012345678",
          "discord:423456789012345678",
          "pk:member-123",
        ],
        guilds: memberLists(
          ["523456789012345678", "<@623456789012345678>", "pk:member-456"],
          ["723456789012345678", "user:823456789012345678"],
        ),
      } satisfies DiscordAccountConfig,
      expectNoNameBasedFinding: true,
    },
  ])("$name", async (testCase) => {
    const findings = await collectFindings({
      config: testCase.config,
      accountId: testCase.accountId,
      orderedAccountIds: testCase.orderedAccountIds,
      hasExplicitAccountPath: testCase.hasExplicitAccountPath,
      storeAllowFrom: testCase.storeAllowFrom,
    });
    const nameBasedFinding = findings.find(
      (entry) => entry.checkId === "channels.discord.allowFrom.name_based_entries",
    );

    if (testCase.expectNoNameBasedFinding) {
      expect(nameBasedFinding).toBeUndefined();
    } else {
      if (!nameBasedFinding) {
        throw new Error(`expected name-based finding for ${testCase.name}`);
      }
      expect(nameBasedFinding.severity).toBe(testCase.expectNameBasedSeverity);
      for (const snippet of testCase.detailIncludes ?? []) {
        expect(nameBasedFinding.detail).toContain(snippet);
      }
      for (const snippet of testCase.detailExcludes ?? []) {
        expect(JSON.stringify(findings)).not.toContain(snippet);
      }
    }
  });
});
