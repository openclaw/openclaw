import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveNextcloudTalkAccount: vi.fn(),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  mockFetchGuard: vi.fn(),
}));

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  fetchWithSsrFGuard: hoisted.mockFetchGuard,
}));
vi.mock("./accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts.js")>()),
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
}));
vi.mock("./signature.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signature.js")>()),
  generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
}));

const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const defaultAccount = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
    config: {},
  };

  beforeEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await fetchMock(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.generateNextcloudTalkSignature.mockClear();
    hoisted.resolveNextcloudTalkAccount.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReturnValue(defaultAccount);
  });

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

  it("signs the unchanged authored text with the configured account credential", async () => {
    const cfg = { source: "provided" } as const;
    const text = "Example:\n⚠️ 🛠️ `search repos (agent)` failed";
    fetchMock.mockResolvedValueOnce(
      Response.json({ ocs: { data: { id: 456, timestamp: 1_706_000_000 } } }),
    );

    await expect(sendMessageNextcloudTalk("room:abc123", text, { cfg })).resolves.toMatchObject({
      messageId: "456",
    });

    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: text,
      secret: "secret-value",
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

    await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      cfg,
      accountId: "work",
    });

    expect(hoisted.resolveNextcloudTalkAccount).toHaveBeenCalledWith({
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
  });
});
