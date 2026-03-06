import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(() => ({
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
    allowPrivateNetwork: null,
  })),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getNextcloudTalkRuntime: () => ({
    config: {
      loadConfig: hoisted.loadConfig,
    },
    channel: {
      text: {
        resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
        convertMarkdownTables: hoisted.convertMarkdownTables,
      },
      activity: {
        record: hoisted.record,
      },
    },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
}));

vi.mock("./signature.js", () => ({
  generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
}));

vi.mock("openclaw/plugin-sdk/nextcloud-talk", () => ({
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
}));

import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";

describe("nextcloud-talk send cfg threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.fetchWithSsrFGuard.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses provided cfg for sendMessage and skips runtime loadConfig", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          ocs: { data: { id: 12345, timestamp: 1_706_000_000 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      finalUrl: "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
      release: vi.fn(),
    });

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
    });

    expect(hoisted.loadConfig).not.toHaveBeenCalled();
    expect(hoisted.resolveNextcloudTalkAccount).toHaveBeenCalledWith({
      cfg,
      accountId: "work",
    });
    expect(hoisted.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messageId: "12345",
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
  });

  it("falls back to runtime cfg for sendReaction when cfg is omitted", async () => {
    const runtimeCfg = { source: "runtime" } as const;
    hoisted.loadConfig.mockReturnValueOnce(runtimeCfg);
    hoisted.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("{}", { status: 200 }),
      finalUrl:
        "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/ops/reaction/m-1",
      release: vi.fn(),
    });

    const result = await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      accountId: "default",
    });

    expect(result).toEqual({ ok: true });
    expect(hoisted.loadConfig).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveNextcloudTalkAccount).toHaveBeenCalledWith({
      cfg: runtimeCfg,
      accountId: "default",
    });
  });
});
