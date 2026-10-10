import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
  ssrfPolicyFromPrivateNetworkOptIn: vi.fn(() => undefined),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  mockFetchGuard: vi.fn(),
}));

vi.mock("./send.runtime.js", () => {
  return {
    convertMarkdownTables: hoisted.convertMarkdownTables,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
    generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
    getOptionalNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
    requireRuntimeConfig: (cfg: unknown, context: string) => {
      if (cfg) {
        return cfg;
      }
      throw new Error(`${context} requires a resolved runtime config`);
    },
    resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
    ssrfPolicyFromPrivateNetworkOptIn: hoisted.ssrfPolicyFromPrivateNetworkOptIn,
  };
});

const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const defaultAccount = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
    config: {},
  };

  function mockNextcloudMessageResponse(messageId: number, timestamp: number): void {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ocs: { data: { id: messageId, timestamp } },
      }),
    );
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Route the SSRF guard mock through the global fetch mock.
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.loadConfig.mockReset();
    hoisted.resolveMarkdownTableMode.mockClear();
    hoisted.convertMarkdownTables.mockClear();
    hoisted.record.mockReset();
    hoisted.ssrfPolicyFromPrivateNetworkOptIn.mockClear();
    hoisted.generateNextcloudTalkSignature.mockClear();
    hoisted.resolveNextcloudTalkAccount.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReturnValue(defaultAccount);
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.unstubAllGlobals();
  });

  function useUnavailableBotSecretAccount() {
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      ...defaultAccount,
      secret: "",
      tokenStatus: "configured_unavailable",
    });
    return { source: "provided" } as const;
  }

  it.each([
    ["configured_unavailable", /bot secret.*configured.*unavailable.*"work".*check/i],
    ["missing", /bot secret missing.*"work".*(set|configure)/i],
  ] as const)(
    "distinguishes %s credentials before signing or sending",
    async (tokenStatus, error) => {
      hoisted.resolveNextcloudTalkAccount.mockReturnValue({
        ...defaultAccount,
        accountId: "work",
        secret: "",
        tokenStatus,
      });

      await expect(
        sendMessageNextcloudTalk("room:abc123", "hello", {
          cfg: { source: "provided" },
          accountId: "work",
        }),
      ).rejects.toThrow(error);

      expect(hoisted.generateNextcloudTalkSignature).not.toHaveBeenCalled();
      expect(hoisted.mockFetchGuard).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("uses an explicit per-call credential when the configured account SecretRef is unavailable", async () => {
    const cfg = useUnavailableBotSecretAccount();
    const text = "Example:\n⚠️ 🛠️ `search repos (agent)` failed";
    mockNextcloudMessageResponse(456, 1_706_000_000);

    await expect(
      sendMessageNextcloudTalk("room:abc123", text, {
        cfg,
        secret: "per-call-secret",
      }),
    ).resolves.toMatchObject({ messageId: "456" });

    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: text,
      secret: "per-call-secret",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ message: text }));
  });

  it("explains that 401 sends can mean the response feature is missing", async () => {
    const cfg = { source: "provided" } as const;
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    await expect(
      sendMessageNextcloudTalk("room:abc123", "hello", {
        cfg,
        accountId: "work",
      }),
    ).rejects.toThrow("--feature response");
  });

  it("uses provided cfg and posts the reaction payload", async () => {
    const cfg = { source: "provided" } as const;
    fetchMock.mockResolvedValueOnce(new Response("", { status: 201 }));

    const result = await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      cfg,
      accountId: "work",
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg,
      accountId: "work",
    });
    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: "👍",
      secret: "secret-value",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/ops/reaction/m-1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OCS-APIRequest": "true",
          "X-Nextcloud-Talk-Bot-Random": "r",
          "X-Nextcloud-Talk-Bot-Signature": "s",
        },
        body: JSON.stringify({ reaction: "👍" }),
      },
    );
    expect(result).toEqual({ ok: true });
  });
});
