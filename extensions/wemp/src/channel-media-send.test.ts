import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

function configFixture(): OpenClawConfig {
  return {
    channels: {
      wemp: {
        enabled: true,
        appId: "app-id",
        appSecret: "app-secret",
        token: "verify-token",
        webhookPath: "/wemp",
      },
    },
  } as OpenClawConfig;
}

function accountId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random()}`;
}

let cachedSendMedia:
  | ((input: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      mediaUrl?: string;
      accountId?: string | null;
    }) => Promise<{ channel: string; messageId: string }>)
  | null = null;

async function resolveSendMedia() {
  if (cachedSendMedia) return cachedSendMedia;

  const numberProto = Number.prototype as Number & { trim?: () => string };
  if (typeof numberProto.trim !== "function") {
    Object.defineProperty(Number.prototype, "trim", {
      value(this: number) {
        return String(this.valueOf());
      },
      configurable: true,
      writable: true,
    });
  }

  const channelModule = await import("../src/channel.js");
  const sendMedia = (channelModule.wempPlugin as any)?.outbound?.sendMedia;
  assert.equal(typeof sendMedia, "function");
  cachedSendMedia = sendMedia as (input: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    accountId?: string | null;
  }) => Promise<{ channel: string; messageId: string }>;
  return cachedSendMedia;
}

function extractUploadType(value: string): string | null {
  if (!value.includes("/cgi-bin/media/upload")) return null;
  const parsed = new URL(value);
  const type = parsed.searchParams.get("type");
  return type ? type.trim().toLowerCase() : null;
}

test("channel outbound sendMedia 文本发送成功", async (t) => {
  const sendMedia = await resolveSendMedia();

  const originalFetch = globalThis.fetch;
  const cfg = configFixture();
  let sendTextCalls = 0;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: "token-text",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendTextCalls += 1;
      assert.equal(typeof init?.body, "string");
      const payload = JSON.parse(init.body as string) as Record<string, unknown>;
      assert.equal(payload.msgtype, "text");
      assert.equal((payload.text as { content?: unknown } | undefined)?.content, "hello-text");
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
          msgid: "wx-msg-text-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const id = accountId("acc-text");
  const result = await sendMedia({
    cfg,
    to: "open-id-text",
    text: "hello-text",
    accountId: id,
  });

  assert.equal(result.channel, "wemp");
  assert.equal(result.messageId, `${id}:open-id-text:wx-msg-text-1`);
  assert.equal(sendTextCalls, 1);
});

test("channel outbound sendMedia 媒体发送成功", async (t) => {
  const sendMedia = await resolveSendMedia();

  const originalFetch = globalThis.fetch;
  const cfg = configFixture();
  const mediaUrl = "https://cdn.example.com/test-image.jpg";
  let downloadCalls = 0;
  let uploadCalls = 0;
  let sendImageCalls = 0;
  let uploadType = "";

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    if (value === mediaUrl) {
      downloadCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: "token-media",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/upload")) {
      uploadCalls += 1;
      uploadType = extractUploadType(value) || "";
      return new Response(
        JSON.stringify({
          type: "image",
          media_id: "media-id-success",
          created_at: 123456,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendImageCalls += 1;
      assert.equal(typeof init?.body, "string");
      const payload = JSON.parse(init!.body as string) as Record<string, unknown>;
      assert.equal(payload.msgtype, "image");
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
          msgid: "wx-msg-media-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const id = accountId("acc-media");
  const result = await sendMedia({
    cfg,
    to: "open-id-media",
    text: "",
    mediaUrl,
    accountId: id,
  });

  assert.equal(result.channel, "wemp");
  assert.equal(result.messageId, `${id}:open-id-media:wx-msg-media-1`);
  assert.equal(downloadCalls, 1);
  assert.equal(uploadCalls, 1);
  assert.equal(uploadType, "image");
  assert.equal(sendImageCalls, 1);
});

test("channel outbound sendMedia 拒绝不安全协议", async () => {
  const sendMedia = await resolveSendMedia();
  const cfg = configFixture();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        sendMedia({
          cfg,
          to: "open-id-protocol-reject",
          text: "",
          mediaUrl: "http://cdn.example.com/not-https.jpg",
          accountId: accountId("acc-protocol-reject"),
        }),
      /wemp_media_url_rejected:unsupported_protocol:http:/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("channel outbound sendMedia 拒绝本地回环地址", async () => {
  const sendMedia = await resolveSendMedia();
  const cfg = configFixture();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        sendMedia({
          cfg,
          to: "open-id-host-reject",
          text: "",
          mediaUrl: "https://127.0.0.1/loopback.jpg",
          accountId: accountId("acc-host-reject"),
        }),
      /wemp_media_url_rejected:blocked_ipv4:127\.0\.0\.1/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("channel outbound sendMedia 可路由 voice/video/file", async (t) => {
  const sendMedia = await resolveSendMedia();
  const originalFetch = globalThis.fetch;
  const cfg = configFixture();
  const mediaCases = [
    {
      name: "voice",
      mediaUrl: "https://cdn.example.com/test-audio.mp3",
      contentType: "audio/mpeg",
      expectedMsgType: "voice",
      expectedUploadType: "voice",
    },
    {
      name: "video",
      mediaUrl: "https://cdn.example.com/test-video.mp4",
      contentType: "video/mp4",
      expectedMsgType: "video",
      expectedUploadType: "video",
    },
    {
      name: "file",
      mediaUrl: "https://cdn.example.com/test-file.pdf",
      contentType: "application/pdf",
      expectedMsgType: "file",
      expectedUploadType: "file",
    },
  ] as const;

  try {
    for (const item of mediaCases) {
      let uploadType = "";
      let messageType = "";
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const value = String(url);
        if (value === item.mediaUrl) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": item.contentType },
          });
        }
        if (value.includes("/cgi-bin/token")) {
          return new Response(
            JSON.stringify({
              access_token: `token-${item.name}`,
              expires_in: 7200,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (value.includes("/cgi-bin/media/upload")) {
          uploadType = extractUploadType(value) || "";
          return new Response(
            JSON.stringify({
              type: item.expectedUploadType,
              media_id: `media-id-${item.name}`,
              created_at: 123456,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (value.includes("/cgi-bin/message/custom/send")) {
          assert.equal(typeof init?.body, "string");
          const payload = JSON.parse(init!.body as string) as Record<string, unknown>;
          messageType = String(payload.msgtype || "");
          return new Response(
            JSON.stringify({
              errcode: 0,
              errmsg: "ok",
              msgid: `wx-msg-${item.name}`,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected url: ${value}`);
      }) as typeof fetch;

      const result = await sendMedia({
        cfg,
        to: `open-id-${item.name}`,
        text: "",
        mediaUrl: item.mediaUrl,
        accountId: accountId(`acc-${item.name}`),
      });

      assert.equal(result.channel, "wemp");
      assert.match(result.messageId, /wx-msg-/);
      assert.equal(uploadType, item.expectedUploadType);
      assert.equal(messageType, item.expectedMsgType);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
});

test("channel outbound sendMedia 文本发送失败时不返回成功回执", async (t) => {
  const sendMedia = await resolveSendMedia();

  const originalFetch = globalThis.fetch;
  const cfg = configFixture();

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: "token-text-fail",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      return new Response(
        JSON.stringify({
          errcode: 40003,
          errmsg: "invalid openid",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      sendMedia({
        cfg,
        to: "open-id-text-fail",
        text: "hello-text-fail",
        accountId: accountId("acc-text-fail"),
      }),
    /wemp_outbound_text_failed:40003:invalid openid/,
  );
});

test("channel outbound sendMedia mediaUrl 下载失败时抛错", async (t) => {
  const sendMedia = await resolveSendMedia();

  const originalFetch = globalThis.fetch;
  const cfg = configFixture();
  const mediaUrl = "https://cdn.example.com/not-found.jpg";

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value === mediaUrl) {
      return new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      sendMedia({
        cfg,
        to: "open-id-download-fail",
        text: "",
        mediaUrl,
        accountId: accountId("acc-download-fail"),
      }),
    /wemp_media_download_failed:http_404/,
  );
});

test("channel outbound sendMedia 上传失败时抛错", async (t) => {
  const sendMedia = await resolveSendMedia();

  const originalFetch = globalThis.fetch;
  const cfg = configFixture();
  const mediaUrl = "https://cdn.example.com/upload-fail.jpg";
  let sendImageCalls = 0;

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value === mediaUrl) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: "token-upload-fail",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/upload")) {
      return new Response(
        JSON.stringify({
          errcode: 45009,
          errmsg: "reach max api daily quota",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendImageCalls += 1;
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      sendMedia({
        cfg,
        to: "open-id-upload-fail",
        text: "",
        mediaUrl,
        accountId: accountId("acc-upload-fail"),
      }),
    /wemp_media_upload_failed:45009:reach max api daily quota/,
  );
  assert.equal(sendImageCalls, 0);
});

test("channel outbound sendMedia 发送失败时抛错", async (t) => {
  const sendMedia = await resolveSendMedia();

  const originalFetch = globalThis.fetch;
  const cfg = configFixture();
  const mediaUrl = "https://cdn.example.com/send-fail.jpg";

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value === mediaUrl) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: "token-send-fail",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/upload")) {
      return new Response(
        JSON.stringify({
          type: "image",
          media_id: "media-id-send-fail",
          created_at: 123456,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      return new Response(
        JSON.stringify({
          errcode: 40003,
          errmsg: "invalid openid",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      sendMedia({
        cfg,
        to: "open-id-send-fail",
        text: "",
        mediaUrl,
        accountId: accountId("acc-send-fail"),
      }),
    /wemp_media_send_failed:40003:invalid openid/,
  );
});
