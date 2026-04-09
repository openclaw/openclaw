import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectTelegramAllowFromUsernameWarnings,
  collectTelegramEmptyAllowlistExtraWarnings,
  collectTelegramGroupPolicyWarnings,
  maybeRepairTelegramAllowFromUsernames,
  scanTelegramAllowFromUsernameEntries,
} from "./doctor.js";

const resolveCommandSecretRefsViaGatewayMock = vi.hoisted(() => vi.fn());
const listTelegramAccountIdsMock = vi.hoisted(() => vi.fn());
const inspectTelegramAccountMock = vi.hoisted(() => vi.fn());
const lookupTelegramChatIdMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime")>(
    "openclaw/plugin-sdk/runtime",
  );
  return {
    ...actual,
    resolveCommandSecretRefsViaGateway: resolveCommandSecretRefsViaGatewayMock,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    listTelegramAccountIds: listTelegramAccountIdsMock,
  };
});

vi.mock("./account-inspect.js", async () => {
  const actual =
    await vi.importActual<typeof import("./account-inspect.js")>("./account-inspect.js");
  return {
    ...actual,
    inspectTelegramAccount: inspectTelegramAccountMock,
  };
});

vi.mock("./api-fetch.js", async () => {
  const actual = await vi.importActual<typeof import("./api-fetch.js")>("./api-fetch.js");
  return {
    ...actual,
    lookupTelegramChatId: lookupTelegramChatIdMock,
  };
});

describe("telegram doctor", () => {
  beforeEach(() => {
    resolveCommandSecretRefsViaGatewayMock.mockReset().mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }));
    listTelegramAccountIdsMock.mockReset().mockReturnValue(["default"]);
    inspectTelegramAccountMock.mockReset().mockReturnValue({
      enabled: true,
      token: "tok",
      tokenSource: "config",
      tokenStatus: "configured",
    });
    lookupTelegramChatIdMock.mockReset();
  });

  it("finds username allowFrom entries across scopes", () => {
    const hits = scanTelegramAllowFromUsernameEntries({
      channels: {
        telegram: {
          allowFrom: ["@top"],
          accounts: {
            work: {
              allowFrom: ["tg:@work"],
              groups: { "-100123": { topics: { "99": { allowFrom: ["@topic"] } } } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(hits).toEqual([
      { path: "channels.telegram.allowFrom", entry: "@top" },
      { path: "channels.telegram.accounts.work.allowFrom", entry: "tg:@work" },
      {
        path: "channels.telegram.accounts.work.groups.-100123.topics.99.allowFrom",
        entry: "@topic",
      },
    ]);
  });

  it("formats group-policy and empty-allowlist warnings", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: { ops: { allow: true } },
      },
      prefix: "channels.telegram",
    });
    expect(warnings[0]).toContain('groupPolicy is "allowlist"');

    expect(
      collectTelegramEmptyAllowlistExtraWarnings({
        account: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
          groups: { ops: { allow: true } },
        },
        channelName: "telegram",
        prefix: "channels.telegram",
      }),
    ).toHaveLength(1);
  });

  it("repairs @username entries to numeric ids", async () => {
    lookupTelegramChatIdMock.mockResolvedValue("111");

    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          botToken: "123:abc",
          allowFrom: ["@testuser"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.config.channels?.telegram?.allowFrom).toEqual(["111"]);
    expect(result.changes[0]).toContain("@testuser");
  });

  it("formats username repair warnings", () => {
    const warnings = collectTelegramAllowFromUsernameWarnings({
      hits: [{ path: "channels.telegram.allowFrom", entry: "@top" }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings[0]).toContain("non-numeric entries");
    expect(warnings[1]).toContain("openclaw doctor --fix");
  });
});
