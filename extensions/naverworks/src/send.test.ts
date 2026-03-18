import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageNaverWorks } from "./send.js";

describe("sendMessageNaverWorks", () => {
  function getRequestBody(fetchMock: ReturnType<typeof vi.fn>): string {
    const call = fetchMock.mock.calls[0];
    const options = call?.[1] as { body?: string } | undefined;
    return options?.body ?? "";
  }

  function getRequestBodyAt(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
    const call = fetchMock.mock.calls[index];
    const options = call?.[1] as { body?: string } | undefined;
    return options?.body ?? "";
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not-configured when botId is missing", async () => {
    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "u1",
      text: "hello",
    });

    expect(result).toEqual({ ok: false, reason: "not-configured" });
  });

  it("posts to NAVER WORKS user message endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      text: "hello",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.worksapis.com/v1.0/bots/bot-1/users/user-1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts image payload when mediaUrl points to an image", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      mediaUrl: "https://example.com/photo.png",
    });

    expect(result).toEqual({ ok: true });
    const body = getRequestBody(fetchMock);
    expect(body).toContain('"type":"image"');
    expect(body).toContain('"previewImageUrl":"https://example.com/photo.png"');
    expect(body).toContain('"originalContentUrl":"https://example.com/photo.png"');
  });

  it("combines remote image and text into a flex payload", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      text: "# Report\n- cpu 40%",
      mediaUrl: "https://example.com/photo.png",
    });

    expect(result).toEqual({ ok: true });
    const body = getRequestBody(fetchMock);
    expect(body).toContain('"type":"flex"');
    expect(body).toContain('"url":"https://example.com/photo.png"');
    expect(body).toContain('"text":"Report"');
  });

  it("uploads local image attachments and sends them as fileId image messages", async () => {
    const tempPath = "/tmp/openclaw-naverworks-send-test.png";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ fileId: "file-1", uploadUrl: "https://upload.example.com/f1" }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ fileId: "file-1", fileName: "photo.png", fileSize: 4 }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fs.writeFile(tempPath, Buffer.from([1, 2, 3, 4]));

    try {
      const result = await sendMessageNaverWorks({
        account: {
          accountId: "default",
          enabled: true,
          webhookPath: "/naverworks/events",
          dmPolicy: "open",
          allowFrom: [],
          botName: "bot",
          strictBinding: true,
          botId: "bot-1",
          accessToken: "token-1",
          tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
          apiBaseUrl: "https://www.worksapis.com/v1.0",
          markdownMode: "auto-flex",
          markdownTheme: "auto",
        },
        toUserId: "user-1",
        mediaUrl: tempPath,
      });

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://www.worksapis.com/v1.0/bots/bot-1/attachments",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://upload.example.com/f1",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://www.worksapis.com/v1.0/bots/bot-1/users/user-1/messages",
        expect.objectContaining({ method: "POST" }),
      );
      expect(getRequestBodyAt(fetchMock, 0)).toContain(
        '"fileName":"openclaw-naverworks-send-test.png"',
      );
      expect(getRequestBodyAt(fetchMock, 0)).toContain('"fileSize":4');
      expect(getRequestBodyAt(fetchMock, 2)).toContain('"type":"image"');
      expect(getRequestBodyAt(fetchMock, 2)).toContain('"fileId":"file-1"');
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  });

  it("posts audio payload when mediaUrl points to an audio file", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      mediaUrl: "https://example.com/voice.ogg",
    });

    expect(result).toEqual({ ok: true });
    const body = getRequestBody(fetchMock);
    expect(body).toContain('"type":"audio"');
    expect(body).toContain('"resourceUrl":"https://example.com/voice.ogg"');
  });

  it("posts flex payload when markdown is detected in auto-flex mode", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      text: "# Report\n- cpu 40%\n- mem 62%",
    });

    expect(result).toEqual({ ok: true });
    const body = getRequestBody(fetchMock);
    expect(body).toContain('"type":"flex"');
    expect(body).toContain('"altText"');
    expect(body).toContain('"contents":{"type":"bubble"');
  });

  it("keeps plain text when markdown mode is plain", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "plain",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      text: "# Report\n- cpu 40%",
    });

    expect(result).toEqual({ ok: true });
    const body = getRequestBody(fetchMock);
    expect(body).toContain('"type":"text"');
    expect(body).toContain('"text":"# Report\\n- cpu 40%"');
  });

  it("posts sticker payload when sticker is provided", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        accessToken: "token-1",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
      },
      toUserId: "user-1",
      sticker: {
        packageId: "1",
        stickerId: "2",
      },
    });

    expect(result).toEqual({ ok: true });
    const body = getRequestBody(fetchMock);
    expect(body).toContain('"type":"sticker"');
    expect(body).toContain('"packageId":"1"');
    expect(body).toContain('"stickerId":"2"');
  });

  it("issues oauth token with JWT auth when accessToken is omitted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "issued-token", expires_in: 86400 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const generatedPrivateKey = crypto
      .generateKeyPairSync("rsa", {
        modulusLength: 2048,
      })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "retry",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        clientId: "client-retry-2",
        clientSecret: "secret-retry-2",
        serviceAccount: "svc-retry-2@example.com",
        privateKey: generatedPrivateKey,
        scope: "bot",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
        jwtIssuer: "issuer-1",
      },
      toUserId: "user-1",
      text: "hello",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://auth.worksmobile.com/oauth2/v2.0/token",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          toString: expect.any(Function),
        }),
      }),
    );
    const firstTokenCall = fetchMock.mock.calls[0]?.[1] as { body?: URLSearchParams } | undefined;
    expect(firstTokenCall?.body?.toString()).toContain("client_secret=secret-retry-2");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.worksapis.com/v1.0/bots/bot-1/users/user-1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retries once with refreshed jwt token on auth failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "issued-token-1", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "issued-token-2", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const generatedPrivateKey = crypto
      .generateKeyPairSync("rsa", {
        modulusLength: 2048,
      })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "default",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        clientId: "client-retry",
        clientSecret: "secret-retry",
        serviceAccount: "svc-retry@example.com",
        privateKey: generatedPrivateKey,
        scope: "bot",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
        jwtIssuer: "issuer-1",
      },
      toUserId: "user-1",
      text: "hello",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://auth.worksmobile.com/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://auth.worksmobile.com/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("returns auth-error details when JWT token endpoint fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("invalid_client", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const generatedPrivateKey = crypto
      .generateKeyPairSync("rsa", {
        modulusLength: 2048,
      })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    const result = await sendMessageNaverWorks({
      account: {
        accountId: "auth-fail",
        enabled: true,
        webhookPath: "/naverworks/events",
        dmPolicy: "open",
        allowFrom: [],
        botName: "bot",
        strictBinding: true,
        botId: "bot-1",
        clientId: "client-auth-fail",
        clientSecret: "secret-auth-fail",
        serviceAccount: "svc-auth-fail@example.com",
        privateKey: generatedPrivateKey,
        scope: "bot",
        tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token",
        apiBaseUrl: "https://www.worksapis.com/v1.0",
        markdownMode: "auto-flex",
        markdownTheme: "auto",
        jwtIssuer: "issuer-auth-fail",
      },
      toUserId: "user-1",
      text: "hello",
    });

    expect(result).toEqual({
      ok: false,
      reason: "auth-error",
      status: 401,
      body: "invalid_client",
    });
  });
});
