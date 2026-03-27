import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { isNumericTelegramUserId, normalizeTelegramAllowFromEntry } from "./allow-from.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";
import {
  isNumericTelegramChatId,
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
  stripTelegramInternalPrefixes,
} from "./targets.js";

const readConfigFileSnapshotForWrite = vi.fn();
const writeConfigFile = vi.fn();
const loadCronStore = vi.fn();
const resolveCronStorePath = vi.fn();
const saveCronStore = vi.fn();

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
    loadCronStore,
    resolveCronStorePath,
    saveCronStore,
  };
});

describe("stripTelegramInternalPrefixes", () => {
  it("strips telegram prefix", () => {
    expect(stripTelegramInternalPrefixes("telegram:123")).toBe("123");
  });

  it("strips telegram+group prefixes", () => {
    expect(stripTelegramInternalPrefixes("telegram:group:-100123")).toBe("-100123");
  });

  it("does not strip group prefix without telegram prefix", () => {
    expect(stripTelegramInternalPrefixes("group:-100123")).toBe("group:-100123");
  });

  it("is idempotent", () => {
    expect(stripTelegramInternalPrefixes("@mychannel")).toBe("@mychannel");
  });
});

describe("parseTelegramTarget", () => {
  it("parses plain chatId", () => {
    expect(parseTelegramTarget("-1001234567890")).toEqual({
      chatId: "-1001234567890",
      chatType: "group",
    });
  });

  it("parses @username", () => {
    expect(parseTelegramTarget("@mychannel")).toEqual({
      chatId: "@mychannel",
      chatType: "unknown",
    });
  });

  it("parses chatId:topicId format", () => {
    expect(parseTelegramTarget("-1001234567890:123")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 123,
      chatType: "group",
    });
  });

  it("parses chatId:topic:topicId format", () => {
    expect(parseTelegramTarget("-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
      chatType: "group",
    });
  });

  it("trims whitespace", () => {
    expect(parseTelegramTarget("  -1001234567890:99  ")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 99,
      chatType: "group",
    });
  });

  it("does not treat non-numeric suffix as topicId", () => {
    expect(parseTelegramTarget("-1001234567890:abc")).toEqual({
      chatId: "-1001234567890:abc",
      chatType: "unknown",
    });
  });

  it("strips internal prefixes before parsing", () => {
    expect(parseTelegramTarget("telegram:group:-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
      chatType: "group",
    });
  });
});

describe("normalizeTelegramChatId", () => {
  it("rejects username and t.me forms", () => {
    expect(normalizeTelegramChatId("telegram:https://t.me/MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("tg:t.me/mychannel")).toBeUndefined();
    expect(normalizeTelegramChatId("@MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("MyChannel")).toBeUndefined();
  });

  it("keeps numeric chat ids unchanged", () => {
    expect(normalizeTelegramChatId("-1001234567890")).toBe("-1001234567890");
    expect(normalizeTelegramChatId("123456789")).toBe("123456789");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeTelegramChatId("  ")).toBeUndefined();
  });
});

describe("normalizeTelegramLookupTarget", () => {
  it("normalizes legacy t.me and username targets", () => {
    expect(normalizeTelegramLookupTarget("telegram:https://t.me/MyChannel")).toBe("@MyChannel");
    expect(normalizeTelegramLookupTarget("tg:t.me/mychannel")).toBe("@mychannel");
    expect(normalizeTelegramLookupTarget("@MyChannel")).toBe("@MyChannel");
    expect(normalizeTelegramLookupTarget("MyChannel")).toBe("@MyChannel");
  });

  it("keeps numeric chat ids unchanged", () => {
    expect(normalizeTelegramLookupTarget("-1001234567890")).toBe("-1001234567890");
    expect(normalizeTelegramLookupTarget("123456789")).toBe("123456789");
  });

  it("rejects invalid username forms", () => {
    expect(normalizeTelegramLookupTarget("@bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("ab")).toBeUndefined();
  });
});

describe("isNumericTelegramChatId", () => {
  it("matches numeric telegram chat ids", () => {
    expect(isNumericTelegramChatId("-1001234567890")).toBe(true);
    expect(isNumericTelegramChatId("123456789")).toBe(true);
  });

  it("rejects non-numeric chat ids", () => {
    expect(isNumericTelegramChatId("@mychannel")).toBe(false);
    expect(isNumericTelegramChatId("t.me/mychannel")).toBe(false);
  });
});

describe("telegram group policy", () => {
  it("resolves topic-level requireMention and chat-level tools for topic ids", () => {
    const telegramCfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              tools: { allow: ["message.send"] },
              topics: {
                "77": {
                  requireMention: false,
                },
              },
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    expect(
      resolveTelegramGroupRequireMention({ cfg: telegramCfg, groupId: "-1001:topic:77" }),
    ).toBe(false);
    expect(resolveTelegramGroupToolPolicy({ cfg: telegramCfg, groupId: "-1001:topic:77" })).toEqual(
      {
        allow: ["message.send"],
      },
    );
  });
});

describe("telegram allow-from helpers", () => {
  it("normalizes tg/telegram prefixes", () => {
    const cases = [
      { value: " TG:123 ", expected: "123" },
      { value: "telegram:@someone", expected: "@someone" },
    ] as const;
    for (const testCase of cases) {
      expect(normalizeTelegramAllowFromEntry(testCase.value)).toBe(testCase.expected);
    }
  });

  it("accepts signed numeric IDs", () => {
    const cases = [
      { value: "123456789", expected: true },
      { value: "-1001234567890", expected: true },
      { value: "@someone", expected: false },
      { value: "12 34", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isNumericTelegramUserId(testCase.value)).toBe(testCase.expected);
    }
  });
});

describe("telegram target normalization", () => {
  it("normalizes telegram prefixes, group targets, and topic suffixes", () => {
    expect(normalizeTelegramMessagingTarget("telegram:123456")).toBe("telegram:123456");
    expect(normalizeTelegramMessagingTarget("tg:group:-100123")).toBe("telegram:group:-100123");
    expect(normalizeTelegramMessagingTarget("telegram:-100123:topic:99")).toBe(
      "telegram:-100123:topic:99",
    );
  });

  it("returns undefined for invalid telegram recipients", () => {
    expect(normalizeTelegramMessagingTarget("telegram:")).toBeUndefined();
    expect(normalizeTelegramMessagingTarget("   ")).toBeUndefined();
  });

  it("detects valid telegram target identifiers", () => {
    expect(looksLikeTelegramTargetId("telegram:123456")).toBe(true);
    expect(looksLikeTelegramTargetId("tg:group:-100123")).toBe(true);
    expect(looksLikeTelegramTargetId("hello world")).toBe(false);
  });
});

describe("maybePersistResolvedTelegramTarget", () => {
  let maybePersistResolvedTelegramTarget: typeof import("./target-writeback.js").maybePersistResolvedTelegramTarget;

  beforeEach(async () => {
    vi.resetModules();
    ({ maybePersistResolvedTelegramTarget } = await import("./target-writeback.js"));
    readConfigFileSnapshotForWrite.mockReset();
    writeConfigFile.mockReset();
    loadCronStore.mockReset();
    resolveCronStorePath.mockReset();
    saveCronStore.mockReset();
    resolveCronStorePath.mockReturnValue("/tmp/cron/jobs.json");
  });

  it("skips writeback when target is already numeric", async () => {
    await maybePersistResolvedTelegramTarget({
      cfg: {} as OpenClawConfig,
      rawTarget: "-100123",
      resolvedChatId: "-100123",
    });

    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(loadCronStore).not.toHaveBeenCalled();
  });

  it("writes back matching config and cron targets", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              defaultTo: "t.me/mychannel",
              accounts: {
                alerts: {
                  defaultTo: "@mychannel",
                },
              },
            },
          },
        },
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    loadCronStore.mockResolvedValue({
      version: 1,
      jobs: [
        { id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } },
        { id: "b", delivery: { channel: "slack", to: "C123" } },
      ],
    });

    await maybePersistResolvedTelegramTarget({
      cfg: {
        cron: { store: "/tmp/cron/jobs.json" },
      } as OpenClawConfig,
      rawTarget: "t.me/mychannel",
      resolvedChatId: "-100123",
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          telegram: {
            defaultTo: "-100123",
            accounts: {
              alerts: {
                defaultTo: "-100123",
              },
            },
          },
        },
      }),
      expect.objectContaining({ expectedConfigPath: "/tmp/openclaw.json" }),
    );
    expect(saveCronStore).toHaveBeenCalledTimes(1);
    expect(saveCronStore).toHaveBeenCalledWith(
      "/tmp/cron/jobs.json",
      expect.objectContaining({
        jobs: [
          { id: "a", delivery: { channel: "telegram", to: "-100123" } },
          { id: "b", delivery: { channel: "slack", to: "C123" } },
        ],
      }),
    );
  });

  it("preserves topic suffix style in writeback target", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              defaultTo: "t.me/mychannel:topic:9",
            },
          },
        },
      },
      writeOptions: {},
    });
    loadCronStore.mockResolvedValue({ version: 1, jobs: [] });

    await maybePersistResolvedTelegramTarget({
      cfg: {} as OpenClawConfig,
      rawTarget: "t.me/mychannel:topic:9",
      resolvedChatId: "-100123",
    });

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          telegram: {
            defaultTo: "-100123:topic:9",
          },
        },
      }),
      expect.any(Object),
    );
  });

  it("matches username targets case-insensitively", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              defaultTo: "https://t.me/mychannel",
            },
          },
        },
      },
      writeOptions: {},
    });
    loadCronStore.mockResolvedValue({
      version: 1,
      jobs: [{ id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } }],
    });

    await maybePersistResolvedTelegramTarget({
      cfg: {} as OpenClawConfig,
      rawTarget: "@MyChannel",
      resolvedChatId: "-100123",
    });

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          telegram: {
            defaultTo: "-100123",
          },
        },
      }),
      expect.any(Object),
    );
    expect(saveCronStore).toHaveBeenCalledWith(
      "/tmp/cron/jobs.json",
      expect.objectContaining({
        jobs: [{ id: "a", delivery: { channel: "telegram", to: "-100123" } }],
      }),
    );
  });
});
