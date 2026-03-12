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

type InboundMediaType = "image" | "voice";

function accountFixture(params: {
  accountId: string;
  webhookPath: string;
  allowFrom?: string[];
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
      handoff: { enabled: true, contact: "service", message: "contact {{contact}}" },
      welcome: { enabled: true, subscribeText: "welcome" },
    },
    config: {},
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
  timestamp: string;
  nonce: string;
}): Promise<{ status: number; body: string }> {
  const url = new URL(params.account.webhookPath, params.baseUrl);
  url.searchParams.set("signature", sign(params.account.token, params.timestamp, params.nonce));
  url.searchParams.set("timestamp", params.timestamp);
  url.searchParams.set("nonce", params.nonce);
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

async function runInboundMediaScenario(params: {
  msgType: InboundMediaType;
  mediaDownloadOk: boolean;
}): Promise<void> {
  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-media-e2e-${params.msgType}-${params.mediaDownloadOk ? "ok" : "fail"}-${uid}`,
    webhookPath: `/wemp-media-e2e-${uid}`,
    allowFrom: [`open-${uid}`],
  });

  const server = await startWebhookServer();
  registerWempWebhook(account);

  let capturedInbound: Record<string, unknown> | null = null;
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        capturedInbound = payload;
      },
    },
  } as any);

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
      if (params.mediaDownloadOk) {
        const bytes =
          params.msgType === "image"
            ? new Uint8Array([1, 2, 3, 4])
            : new Uint8Array([5, 6, 7, 8, 9]);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": params.msgType === "image" ? "image/jpeg" : "audio/amr",
            "content-disposition": `attachment; filename="${params.msgType}-sample.${params.msgType === "image" ? "jpg" : "amr"}"`,
          },
        });
      }
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

  try {
    const timestamp = params.msgType === "image" ? "1710200001" : "1710200002";
    const nonce = `nonce-${params.msgType}-${params.mediaDownloadOk ? "ok" : "fail"}`;
    const openId = `open-${uid}`;
    const mediaId = `media-${params.msgType}-${uid}`;
    const picUrl = `https://example.com/${uid}.jpg`;
    const body =
      params.msgType === "image"
        ? buildImageMessageXml({
            toUser: "gh_media",
            fromUser: openId,
            createTime: timestamp,
            msgId: `msg-image-${uid}`,
            picUrl,
            mediaId,
          })
        : buildVoiceMessageXml({
            toUser: "gh_media",
            fromUser: openId,
            createTime: timestamp,
            msgId: `msg-voice-${uid}`,
            mediaId,
          });

    const result = await postWebhook({
      baseUrl: server.baseUrl,
      account,
      body,
      timestamp,
      nonce,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body, "success");
    assert.ok(capturedInbound);
    assert.equal(capturedInbound?.["targetAgentId"], "main");
    assert.equal(capturedInbound?.["userId"], openId);

    const text = String(capturedInbound?.["text"] || "");
    if (params.msgType === "image") {
      assert.match(text, new RegExp(`^\\[image\\] https://example\\.com/${uid}\\.jpg`));
    } else {
      assert.equal(text.startsWith(`[voice] ${mediaId}`), true);
    }

    if (params.mediaDownloadOk) {
      assert.match(text, /\[media-summary\]/);
      assert.match(
        text,
        params.msgType === "image" ? /contentType=image\/jpeg/ : /contentType=audio\/amr/,
      );
      assert.match(text, params.msgType === "image" ? /size=4B/ : /size=5B/);
      assert.match(
        text,
        params.msgType === "image" ? /filename=image-sample\.jpg/ : /filename=voice-sample\.amr/,
      );
    } else if (params.msgType === "image") {
      assert.equal(text, `[image] ${picUrl}`);
      assert.doesNotMatch(text, /\[media-summary\]/);
    } else {
      assert.equal(text, `[voice] ${mediaId}`);
      assert.doesNotMatch(text, /\[media-summary\]/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearWempRuntime();
    unregisterWempWebhook(account);
    await server.close();
  }
}

test("e2e media inbound image appends summary when media download succeeds", async () => {
  await runInboundMediaScenario({
    msgType: "image",
    mediaDownloadOk: true,
  });
});

test("e2e media inbound image keeps normalized text when media download is unavailable", async () => {
  await runInboundMediaScenario({
    msgType: "image",
    mediaDownloadOk: false,
  });
});

test("e2e media inbound voice appends summary when media download succeeds", async () => {
  await runInboundMediaScenario({
    msgType: "voice",
    mediaDownloadOk: true,
  });
});

test("e2e media inbound voice keeps normalized text when media download is unavailable", async () => {
  await runInboundMediaScenario({
    msgType: "voice",
    mediaDownloadOk: false,
  });
});
