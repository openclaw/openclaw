import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { sendText } from "../src/http.js";
import { clearWempRuntime, setWempRuntime } from "../src/runtime.js";
import type { ResolvedWempAccount } from "../src/types.js";
import {
  handleRegisteredWebhookRequest,
  registerWempWebhook,
  unregisterWempWebhook,
} from "../src/webhook.js";

function accountFixture(params: {
  accountId: string;
  webhookPath: string;
  allowFrom?: string[];
  voiceTranscribeEndpoint?: string;
}): ResolvedWempAccount {
  return {
    accountId: params.accountId,
    enabled: true,
    configured: true,
    appId: `app-${params.accountId}`,
    appSecret: "secret",
    token: `token-${params.accountId}`,
    webhookPath: params.webhookPath,
    dm: { policy: "pairing", allowFrom: params.allowFrom || [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: true, defaultEnabled: true },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: {
        enabled: true,
        contact: "客服微信: abc",
        message: "如需人工支持，请联系：{{contact}}",
      },
      welcome: { enabled: true, subscribeText: "欢迎关注" },
    },
    config: params.voiceTranscribeEndpoint
      ? ({ voiceTranscribe: { endpoint: params.voiceTranscribeEndpoint } } as any)
      : {},
  };
}

function sign(token: string, timestamp: string, nonce: string): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

async function startWebhookServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const handled = await handleRegisteredWebhookRequest(req, res);
    if (!handled) sendText(res, 404, "not handled");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function postWebhook(params: {
  baseUrl: string;
  account: ResolvedWempAccount;
  body: string;
  timestamp?: string;
  nonce?: string;
}): Promise<{ status: number; body: string }> {
  const timestamp = params.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = params.nonce || "nonce-test";
  const url = new URL(params.account.webhookPath, params.baseUrl);
  url.searchParams.set("signature", sign(params.account.token, timestamp, nonce));
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/xml; charset=utf-8" },
    body: params.body,
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

function buildImageMessageXml(params: {
  toUser: string;
  fromUser: string;
  createTime: string;
  msgId: string;
  picUrl: string;
  mediaId: string;
}): string {
  return `<xml>
<ToUserName><![CDATA[${params.toUser}]]></ToUserName>
<FromUserName><![CDATA[${params.fromUser}]]></FromUserName>
<CreateTime>${params.createTime}</CreateTime>
<MsgType><![CDATA[image]]></MsgType>
<PicUrl><![CDATA[${params.picUrl}]]></PicUrl>
<MediaId><![CDATA[${params.mediaId}]]></MediaId>
<MsgId>${params.msgId}</MsgId>
</xml>`;
}

function buildVoiceMessageXml(params: {
  toUser: string;
  fromUser: string;
  createTime: string;
  msgId: string;
  mediaId: string;
}): string {
  return `<xml>
<ToUserName><![CDATA[${params.toUser}]]></ToUserName>
<FromUserName><![CDATA[${params.fromUser}]]></FromUserName>
<CreateTime>${params.createTime}</CreateTime>
<MsgType><![CDATA[voice]]></MsgType>
<MediaId><![CDATA[${params.mediaId}]]></MediaId>
<Format><![CDATA[amr]]></Format>
<MsgId>${params.msgId}</MsgId>
</xml>`;
}

test("image inbound message appends media summary after successful download", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-image-${uid}`;
  const account = accountFixture({
    accountId: `acc-image-${uid}`,
    webhookPath: `/wemp-image-${uid}`,
    allowFrom: [openId],
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  let captured: Record<string, unknown> | null = null;
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        captured = payload;
      },
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${uid}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/get")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-disposition": 'attachment; filename="photo.jpg"',
        },
      });
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildImageMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710100001",
      msgId: `msg-image-${uid}`,
      picUrl: "https://example.com/pic.jpg",
      mediaId: `media-image-${uid}`,
    }),
    timestamp: "1710100001",
    nonce: "nonce-image",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.ok(captured);
  const text = String(captured?.["text"] || "");
  assert.match(text, /^\[image\] https:\/\/example\.com\/pic\.jpg/m);
  assert.match(text, /\[media-summary\]/);
  assert.match(text, /contentType=image\/jpeg/);
  assert.match(text, /size=4B/);
});

test("voice inbound message degrades gracefully when media download fails", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-voice-${uid}`;
  const account = accountFixture({
    accountId: `acc-voice-${uid}`,
    webhookPath: `/wemp-voice-${uid}`,
    allowFrom: [openId],
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  let captured: Record<string, unknown> | null = null;
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        captured = payload;
      },
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${uid}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/get")) {
      return new Response(
        JSON.stringify({
          errcode: 40007,
          errmsg: "invalid media_id",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildVoiceMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710100002",
      msgId: `msg-voice-${uid}`,
      mediaId: `media-voice-${uid}`,
    }),
    timestamp: "1710100002",
    nonce: "nonce-voice",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.ok(captured);
  const text = String(captured?.["text"] || "");
  assert.equal(text, `[voice] media-voice-${uid}`);
  assert.doesNotMatch(text, /\[media-summary\]/);
});

test("voice inbound message appends transcript summary when independent transcribe is configured", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-voice-transcribe-${uid}`;
  const mediaId = `media-voice-transcribe-${uid}`;
  const transcribeEndpoint = `https://transcribe.local/${uid}`;
  const account = accountFixture({
    accountId: `acc-voice-transcribe-${uid}`,
    webhookPath: `/wemp-voice-transcribe-${uid}`,
    allowFrom: [openId],
    voiceTranscribeEndpoint: transcribeEndpoint,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  let captured: Record<string, unknown> | null = null;
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        captured = payload;
      },
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  let transcribeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${uid}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/get")) {
      return new Response(new Uint8Array([8, 7, 6, 5]), {
        status: 200,
        headers: {
          "content-type": "audio/amr",
          "content-disposition": 'attachment; filename="voice.amr"',
        },
      });
    }
    if (value === transcribeEndpoint) {
      transcribeCalls += 1;
      assert.equal(init?.method, "POST");
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      assert.equal(payload["mediaId"], mediaId);
      assert.equal(payload["contentType"], "audio/amr");
      assert.equal(typeof payload["audioBase64"], "string");
      return new Response(
        JSON.stringify({
          transcript: "这是独立转写摘要",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildVoiceMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710100003",
      msgId: `msg-voice-transcribe-${uid}`,
      mediaId,
    }),
    timestamp: "1710100003",
    nonce: "nonce-voice-transcribe",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.equal(transcribeCalls, 1);
  assert.ok(captured);
  const text = String(captured?.["text"] || "");
  assert.equal(text.startsWith(`[voice] ${mediaId}`), true);
  assert.match(text, /\[media-summary\]/);
  assert.match(text, /contentType=audio\/amr/);
  assert.match(text, /size=4B/);
  assert.match(text, /transcript=这是独立转写摘要/);
});

test("voice inbound message keeps media summary when transcribe endpoint fails via env fallback", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-voice-transcribe-env-${uid}`;
  const mediaId = `media-voice-transcribe-env-${uid}`;
  const transcribeEndpoint = `https://transcribe-env.local/${uid}`;
  const previousEndpoint = process.env.WEMP_VOICE_TRANSCRIBE_ENDPOINT;
  process.env.WEMP_VOICE_TRANSCRIBE_ENDPOINT = transcribeEndpoint;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.WEMP_VOICE_TRANSCRIBE_ENDPOINT;
    else process.env.WEMP_VOICE_TRANSCRIBE_ENDPOINT = previousEndpoint;
  });

  const account = accountFixture({
    accountId: `acc-voice-transcribe-env-${uid}`,
    webhookPath: `/wemp-voice-transcribe-env-${uid}`,
    allowFrom: [openId],
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  let captured: Record<string, unknown> | null = null;
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        captured = payload;
      },
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  let transcribeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${uid}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/media/get")) {
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: {
          "content-type": "audio/amr",
          "content-disposition": 'attachment; filename="voice-env.amr"',
        },
      });
    }
    if (value === transcribeEndpoint) {
      transcribeCalls += 1;
      assert.equal(init?.method, "POST");
      return new Response("upstream error", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildVoiceMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710100004",
      msgId: `msg-voice-transcribe-env-${uid}`,
      mediaId,
    }),
    timestamp: "1710100004",
    nonce: "nonce-voice-transcribe-env",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.equal(transcribeCalls, 1);
  assert.ok(captured);
  const text = String(captured?.["text"] || "");
  assert.equal(text.startsWith(`[voice] ${mediaId}`), true);
  assert.match(text, /\[media-summary\]/);
  assert.match(text, /contentType=audio\/amr/);
  assert.match(text, /size=5B/);
  assert.doesNotMatch(text, /transcript=/);
});
