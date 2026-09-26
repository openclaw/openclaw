// Nextcloud Talk tests cover send.cfg threading plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig as CoreConfig } from "openclaw/plugin-sdk/config-contracts";
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
    getNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
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

const { nextcloudTalkMessageAdapter } = await import("./message-adapter.js");
const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");

function expectProvidedMessageCfgThreading(cfg: unknown): void {
  expectProvidedCfgSkipsRuntimeLoad({
    loadConfig: hoisted.loadConfig,
    resolveAccount: hoisted.resolveNextcloudTalkAccount,
    cfg,
    accountId: "work",
  });
  expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
    cfg,
    channel: "nextcloud-talk",
    accountId: "default",
  });
  expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
}

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const fixedSentAt = 1_800_000_000_000;
  const defaultAccount = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
  };

  function mockNextcloudMessageResponse(messageId: number, timestamp: number): void {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ocs: { data: { id: messageId, timestamp } },
      }),
    );
  }

  beforeEach(() => {
    vi.setSystemTime(fixedSentAt);
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
    vi.useRealTimers();
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
    mockNextcloudMessageResponse(456, 1_706_000_000);

    await expect(
      sendMessageNextcloudTalk("room:abc123", "hello", {
        cfg,
        secret: "per-call-secret",
      }),
    ).resolves.toMatchObject({ messageId: "456" });

    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: "hello",
      secret: "per-call-secret",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "preserves cfg and receipts with runtime initialized=%s",
    async (initialized) => {
      const cfg = { source: "provided" } as const;
      if (!initialized) {
        hoisted.record.mockImplementation(() => {
          throw new Error("Nextcloud Talk runtime not initialized");
        });
      }
      mockNextcloudMessageResponse(12345, 1_706_000_000);

      const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
        cfg,
        accountId: "work",
      });

      expectProvidedMessageCfgThreading(cfg);
      expect(hoisted.record).toHaveBeenCalledWith({
        channel: "nextcloud-talk",
        accountId: "default",
        direction: "outbound",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        messageId: "12345",
        receipt: {
          platformMessageIds: ["12345"],
          primaryPlatformMessageId: "12345",
          parts: [
            {
              index: 0,
              kind: "text",
              platformMessageId: "12345",
              raw: {
                channel: "nextcloud-talk",
                conversationId: "abc123",
                messageId: "12345",
              },
            },
          ],
          raw: [
            {
              channel: "nextcloud-talk",
              conversationId: "abc123",
              messageId: "12345",
            },
          ],
          sentAt: fixedSentAt,
        },
        roomToken: "abc123",
        timestamp: 1_706_000_000,
      });
    },
  );

  it("strips mixed-case provider and room prefixes before sending", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(12344, 1_706_000_000);

    const result = await sendMessageNextcloudTalk("NC-TALK:ROOM:Ops", "hello", {
      cfg,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/Ops/message",
      expect.any(Object),
    );
    expect(result.roomToken).toBe("Ops");
    expect(result.receipt.raw).toEqual([
      {
        channel: "nextcloud-talk",
        conversationId: "Ops",
        messageId: "12344",
      },
    ]);
  });

  it("preserves caller-authored text on the low-level send path", async () => {
    const cfg = { source: "provided" } as const;
    const text = "Example:\n⚠️ 🛠️ `search repos (agent)` failed";
    mockNextcloudMessageResponse(12346, 1_706_000_001);

    await sendMessageNextcloudTalk("room:abc123", text, {
      cfg,
      accountId: "work",
      replyTo: "parent-1",
    });

    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: text,
      secret: "secret-value",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ message: text, replyTo: "parent-1" }),
    );
  });

  it("preserves reply ids in receipts", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(12347, 1_706_000_002);

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
      replyTo: "parent-1",
    });

    expect(result.receipt).toEqual({
      platformMessageIds: ["12347"],
      primaryPlatformMessageId: "12347",
      replyToId: "parent-1",
      parts: [
        {
          index: 0,
          kind: "text",
          replyToId: "parent-1",
          platformMessageId: "12347",
          raw: {
            channel: "nextcloud-talk",
            conversationId: "abc123",
            messageId: "12347",
          },
        },
      ],
      raw: [
        {
          channel: "nextcloud-talk",
          conversationId: "abc123",
          messageId: "12347",
        },
      ],
      sentAt: fixedSentAt,
    });
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

  it("declares message adapter durable text, media, and reply with receipt proofs", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(22345, 1_706_000_003);
    mockNextcloudMessageResponse(22346, 1_706_000_004);
    mockNextcloudMessageResponse(22347, 1_706_000_005);

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "nextcloud-talk",
      adapter: nextcloudTalkMessageAdapter,
      proofs: {
        text: async () => {
          const result = await nextcloudTalkMessageAdapter.send?.text?.({
            cfg: cfg as CoreConfig,
            to: "room:abc123",
            text: "hello",
            accountId: "work",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["22345"]);
        },
        media: async () => {
          const result = await nextcloudTalkMessageAdapter.send?.media?.({
            cfg: cfg as CoreConfig,
            to: "room:abc123",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            accountId: "work",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["22346"]);
          const mediaSendCall = fetchMock.mock.calls.at(1);
          expect(mediaSendCall?.[0]).toBe(
            "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
          );
          expect(mediaSendCall?.[1]?.body).toBe(
            JSON.stringify({
              message: "image\n\nAttachment: https://example.com/image.png",
            }),
          );
        },
        replyTo: async () => {
          const result = await nextcloudTalkMessageAdapter.send?.text?.({
            cfg: cfg as CoreConfig,
            to: "room:abc123",
            text: "threaded",
            replyToId: "parent-1",
            accountId: "work",
          });
          expect(result?.receipt.replyToId).toBe("parent-1");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });

  it("fails hard for sendReaction when cfg is omitted", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(
      sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
        accountId: "default",
      } as never),
    ).rejects.toThrow("Nextcloud Talk send requires a resolved runtime config");

    expect(hoisted.loadConfig).not.toHaveBeenCalled();
    expect(hoisted.resolveNextcloudTalkAccount).not.toHaveBeenCalled();
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

  it("surfaces sendReaction HTTP failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(
      sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
        cfg: { source: "provided" },
        accountId: "work",
      }),
    ).rejects.toThrow("Nextcloud Talk reaction failed: 403 forbidden");
  });
});

describe("nextcloud-talk send bounded response reads", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const account = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
  };

  // Builds a streaming body with NO content-length so only the streaming byte
  // cap can stop it. `chunks` chunks of `chunkBytes` each => total may exceed cap.
  function streamingResponse(params: {
    status: number;
    chunkBytes: number;
    chunks: number;
    contentType: string;
    fill?: number;
  }): Response {
    let remaining = params.chunks;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        remaining -= 1;
        controller.enqueue(new Uint8Array(params.chunkBytes).fill(params.fill ?? 0x7b));
      },
    });
    return new Response(stream, {
      status: params.status,
      headers: { "content-type": params.contentType },
    });
  }

  function streamingReceiptResponse(paddingChunks: number) {
    const observed = { cancellations: 0, tailEmitted: false };
    const encoder = new TextEncoder();
    let nextChunk = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (nextChunk === 0) {
            controller.enqueue(
              encoder.encode('{"ocs":{"data":{"id":987654,"timestamp":1706000009}},"padding":"'),
            );
          } else if (nextChunk <= paddingChunks) {
            controller.enqueue(new Uint8Array(1024 * 1024).fill(0x78));
          } else {
            observed.tailEmitted = true;
            controller.enqueue(encoder.encode('"}'));
            controller.close();
          }
          nextChunk += 1;
        },
        cancel() {
          observed.cancellations += 1;
        },
      },
      // No read-ahead: the tail records consumption, not an eagerly filled queue.
      { highWaterMark: 0 },
    );
    return {
      response: new Response(stream, { headers: { "content-type": "application/json" } }),
      observed,
    };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.resolveNextcloudTalkAccount.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReturnValue(account);
    hoisted.record.mockReset();
    hoisted.generateNextcloudTalkSignature.mockClear();
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "keeps the unknown receipt when a success body exceeds the JSON byte cap",
      paddingChunks: 17,
      messageId: "unknown",
      timestamp: undefined,
      platformMessageIds: [],
      primaryPlatformMessageId: undefined,
      observed: { cancellations: 1, tailEmitted: false },
    },
    {
      name: "reads the receipt when a streamed success body stays below the JSON byte cap",
      paddingChunks: 1,
      messageId: "987654",
      timestamp: 1706000009,
      platformMessageIds: ["987654"],
      primaryPlatformMessageId: "987654",
      observed: { cancellations: 0, tailEmitted: true },
    },
  ])("$name", async (expected) => {
    // Both bodies are valid JSON, so an unbounded reader would expose the literal receipt.
    const { response, observed } = streamingReceiptResponse(expected.paddingChunks);
    expect(response.headers.has("content-length")).toBe(false);
    fetchMock.mockResolvedValueOnce(response);
    const result = await sendMessageNextcloudTalk("room:abc", "hello", {
      cfg: { source: "provided" },
    });

    expect(result.messageId).toBe(expected.messageId);
    expect(result.timestamp).toBe(expected.timestamp);
    expect(result.receipt.platformMessageIds).toEqual(expected.platformMessageIds);
    expect(result.receipt.primaryPlatformMessageId).toBe(expected.primaryPlatformMessageId);
    expect(observed).toEqual(expected.observed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.mockFetchGuard).toHaveBeenCalledTimes(1);
  });

  it("omits an oversized error body from the send failure", async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse({
        status: 400,
        chunkBytes: 1024 * 1024,
        chunks: 17,
        contentType: "text/plain",
      }),
    );

    await expect(
      sendMessageNextcloudTalk("room:abc", "hello", { cfg: { source: "provided" } }),
    ).rejects.toThrow(new Error("Nextcloud Talk: bad request - invalid message format"));
  });

  it("omits an oversized error body from the reaction failure", async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse({
        status: 500,
        chunkBytes: 1024 * 1024,
        chunks: 17,
        contentType: "text/plain",
      }),
    );

    await expect(
      sendReactionNextcloudTalk("room:abc", "m-1", "👍", { cfg: { source: "provided" } }),
    ).rejects.toThrow(new Error("Nextcloud Talk reaction failed: 500"));
  });
});
