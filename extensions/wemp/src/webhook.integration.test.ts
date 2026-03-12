import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import test from "node:test";
import { encryptWechatMessage } from "../src/crypto.js";
import { sendText } from "../src/http.js";
import { getWempDataRoot } from "../src/storage.js";
import type { ResolvedWempAccount } from "../src/types.js";

const DATA_DIR = getWempDataRoot();
const TEST_ENCODING_AES_KEY = Buffer.alloc(32, 7).toString("base64").slice(0, 43);
process.env.WEMP_ASSISTANT_TOGGLE_PERSIST_DEBOUNCE_MS =
  process.env.WEMP_ASSISTANT_TOGGLE_PERSIST_DEBOUNCE_MS || "250";
process.env.WEMP_USAGE_LIMIT_PERSIST_DEBOUNCE_MS =
  process.env.WEMP_USAGE_LIMIT_PERSIST_DEBOUNCE_MS || "250";
const numberPrototype = Number.prototype as Number & { trim?: () => string };
if (typeof numberPrototype.trim !== "function") {
  numberPrototype.trim = function trim(this: number): string {
    return String(this);
  };
}
const { consumeHandoffNotifications } = await import("../src/features/handoff-notify.js");
const { clearWempRuntime, setWempRuntime } = await import("../src/runtime.js");
const { handleRegisteredWebhookRequest, registerWempWebhook, unregisterWempWebhook } =
  await import("../src/webhook.js");

interface FileSnapshot {
  existed: boolean;
  content: string;
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { existed: false, content: "" };
  return { existed: true, content: readFileSync(file, "utf8") };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(file, snapshot.content, "utf8");
    return;
  }
  rmSync(file, { force: true });
}

function accountFixture(params: {
  accountId: string;
  webhookPath: string;
  allowFrom?: string[];
  requireHttps?: boolean;
}): ResolvedWempAccount {
  return {
    accountId: params.accountId,
    enabled: true,
    configured: true,
    appId: `app-${params.accountId}`,
    appSecret: "secret",
    token: `token-${params.accountId}`,
    webhookPath: params.webhookPath,
    requireHttps: params.requireHttps ?? false,
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
        ticketWebhook: {
          enabled: true,
          endpoint: "https://tickets.example.com/handoff",
          events: ["activated", "resumed"],
        },
      },
      welcome: { enabled: true, subscribeText: "欢迎关注" },
    },
    config: {},
  };
}

function sign(token: string, timestamp: string, nonce: string): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

function signMessage(token: string, timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
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
  signature?: string;
  msgSignature?: string;
  allowStaleTimestamp?: boolean;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const requestedTimestamp = params.timestamp || String(nowSeconds);
  const parsedTimestamp = Number(requestedTimestamp);
  const timestamp = params.allowStaleTimestamp
    ? requestedTimestamp
    : !Number.isFinite(parsedTimestamp) || Math.abs(nowSeconds - Math.floor(parsedTimestamp)) > 300
      ? String(nowSeconds)
      : String(Math.floor(parsedTimestamp));
  const nonce = params.nonce || "nonce-test";
  const signature = params.signature || sign(params.account.token, timestamp, nonce);
  const url = new URL(params.account.webhookPath, params.baseUrl);
  url.searchParams.set("signature", signature);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  if (params.msgSignature) {
    url.searchParams.set("msg_signature", params.msgSignature);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/xml; charset=utf-8",
      ...(params.headers || {}),
    },
    body: params.body,
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

async function getWebhook(params: {
  baseUrl: string;
  account: ResolvedWempAccount;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  msgSignature?: string;
  echostr?: string;
}): Promise<{ status: number; body: string }> {
  const timestamp = params.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = params.nonce || "nonce-get";
  const signature = params.signature || sign(params.account.token, timestamp, nonce);
  const echostr = params.echostr || "echo-ok";
  const url = new URL(params.account.webhookPath, params.baseUrl);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("signature", signature);
  url.searchParams.set("echostr", echostr);
  if (params.msgSignature) {
    url.searchParams.set("msg_signature", params.msgSignature);
  }
  const response = await fetch(url, {
    method: "GET",
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

async function postWebhookWithOpenBody(params: {
  baseUrl: string;
  account: ResolvedWempAccount;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  headers?: Record<string, string>;
  bodyPrefix?: string;
}): Promise<{ status: number; body: string }> {
  const timestamp = params.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = params.nonce || "nonce-timeout";
  const signature = params.signature || sign(params.account.token, timestamp, nonce);
  const url = new URL(params.account.webhookPath, params.baseUrl);
  url.searchParams.set("signature", signature);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);

  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/xml; charset=utf-8",
          ...(params.headers || {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () => {
          request.destroy();
          resolve({
            status: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    request.setTimeout(5_000, () => {
      request.destroy(new Error("timeout waiting for webhook response"));
    });
    request.write(params.bodyPrefix || "<xml>");
  });
}

function buildEncryptedWebhookPayload(params: {
  account: ResolvedWempAccount;
  plainXml: string;
  timestamp: string;
  nonce: string;
}): { body: string; msgSignature: string } {
  assert.ok(params.account.encodingAESKey);
  const encrypted = encryptWechatMessage(
    params.plainXml,
    params.account.encodingAESKey,
    params.account.appId,
  );
  return {
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    msgSignature: signMessage(params.account.token, params.timestamp, params.nonce, encrypted),
  };
}

function buildSubscribeEventXml(params: {
  toUser: string;
  fromUser: string;
  createTime: string;
  msgId: string;
}): string {
  return `<xml>
<ToUserName><![CDATA[${params.toUser}]]></ToUserName>
<FromUserName><![CDATA[${params.fromUser}]]></FromUserName>
<CreateTime>${params.createTime}</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[subscribe]]></Event>
<MsgId>${params.msgId}</MsgId>
</xml>`;
}

function buildTextMessageXml(params: {
  toUser: string;
  fromUser: string;
  createTime: string;
  msgId: string;
  content: string;
}): string {
  return `<xml>
<ToUserName><![CDATA[${params.toUser}]]></ToUserName>
<FromUserName><![CDATA[${params.fromUser}]]></FromUserName>
<CreateTime>${params.createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${params.content}]]></Content>
<MsgId>${params.msgId}</MsgId>
</xml>`;
}

function buildClickEventXml(params: {
  toUser: string;
  fromUser: string;
  createTime: string;
  msgId: string;
  eventKey: string;
}): string {
  return `<xml>
<ToUserName><![CDATA[${params.toUser}]]></ToUserName>
<FromUserName><![CDATA[${params.fromUser}]]></FromUserName>
<CreateTime>${params.createTime}</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[CLICK]]></Event>
<EventKey><![CDATA[${params.eventKey}]]></EventKey>
<MsgId>${params.msgId}</MsgId>
</xml>`;
}

test("register + handleRegisteredWebhookRequest flow routes requests to registered webhook path", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-register-${uid}`,
    webhookPath: `/wemp-register-${uid}`,
  });
  const body = buildSubscribeEventXml({
    toUser: "gh_xxx",
    fromUser: `open-${uid}`,
    createTime: "1710001000",
    msgId: `msg-sub-${uid}`,
  });

  const beforeRegister = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body,
  });
  assert.equal(beforeRegister.status, 404);
  assert.equal(beforeRegister.body, "not handled");

  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const afterRegister = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body,
  });
  assert.equal(afterRegister.status, 200);
  assert.match(afterRegister.body, /<xml>/);
  assert.match(afterRegister.body, /<MsgType><!\[CDATA\[text\]\]><\/MsgType>/);
  assert.match(afterRegister.body, /欢迎关注/);
});

test("handleRegisteredWebhookRequest returns 403 when signature verification fails", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-sign-${uid}`,
    webhookPath: `/wemp-sign-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-${uid}`,
      createTime: "1710002000",
      msgId: `msg-sign-${uid}`,
      content: "hello",
    }),
    signature: "invalid-signature",
    timestamp: "1710002000",
    nonce: "nonce-sign",
  });
  assert.equal(result.status, 403);
  assert.equal(result.body, "Invalid signature");
});

test("plain webhook GET verification echoes echostr when signature is valid", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-get-verify-${uid}`,
    webhookPath: `/wemp-get-verify-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const echostr = `echo-${uid}`;
  const result = await getWebhook({
    baseUrl: server.baseUrl,
    account,
    nonce: "nonce-get-verify",
    echostr,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, echostr);
});

test("webhook rejects insecure requests when WEMP_REQUIRE_HTTPS=1", async (t) => {
  const previous = process.env.WEMP_REQUIRE_HTTPS;
  process.env.WEMP_REQUIRE_HTTPS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.WEMP_REQUIRE_HTTPS;
    else process.env.WEMP_REQUIRE_HTTPS = previous;
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-https-block-${uid}`,
    webhookPath: `/wemp-https-block-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-https-block-${uid}`,
      createTime: "1710002600",
      msgId: `msg-https-block-${uid}`,
      content: "hello",
    }),
    timestamp: "1710002600",
    nonce: "nonce-https-block",
  });

  assert.equal(result.status, 403);
  assert.equal(result.body, "HTTPS required");
});

test("webhook rejects insecure requests when account.requireHttps=true", async (t) => {
  const previous = process.env.WEMP_REQUIRE_HTTPS;
  delete process.env.WEMP_REQUIRE_HTTPS;
  t.after(() => {
    if (previous === undefined) delete process.env.WEMP_REQUIRE_HTTPS;
    else process.env.WEMP_REQUIRE_HTTPS = previous;
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-https-config-block-${uid}`,
    webhookPath: `/wemp-https-config-block-${uid}`,
    requireHttps: true,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-https-config-block-${uid}`,
      createTime: "1710002650",
      msgId: `msg-https-config-block-${uid}`,
      content: "hello",
    }),
    timestamp: "1710002650",
    nonce: "nonce-https-config-block",
  });

  assert.equal(result.status, 403);
  assert.equal(result.body, "HTTPS required");
});

test("webhook rejects spoofed x-forwarded-proto=https when trusted proxy is disabled", async (t) => {
  const previous = process.env.WEMP_REQUIRE_HTTPS;
  const previousTrustProxy = process.env.WEMP_WEBHOOK_TRUST_PROXY;
  process.env.WEMP_REQUIRE_HTTPS = "1";
  delete process.env.WEMP_WEBHOOK_TRUST_PROXY;
  t.after(() => {
    if (previous === undefined) delete process.env.WEMP_REQUIRE_HTTPS;
    else process.env.WEMP_REQUIRE_HTTPS = previous;
    if (previousTrustProxy === undefined) delete process.env.WEMP_WEBHOOK_TRUST_PROXY;
    else process.env.WEMP_WEBHOOK_TRUST_PROXY = previousTrustProxy;
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-https-forwarded-${uid}`,
    webhookPath: `/wemp-https-forwarded-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildSubscribeEventXml({
      toUser: "gh_xxx",
      fromUser: `open-https-forwarded-${uid}`,
      createTime: "1710002700",
      msgId: `msg-https-forwarded-${uid}`,
    }),
    timestamp: "1710002700",
    nonce: "nonce-https-forwarded",
    headers: {
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(result.status, 403);
  assert.equal(result.body, "HTTPS required");
});

test("webhook allows x-forwarded-proto=https when trusted proxy is enabled", async (t) => {
  const previous = process.env.WEMP_REQUIRE_HTTPS;
  const previousTrustProxy = process.env.WEMP_WEBHOOK_TRUST_PROXY;
  process.env.WEMP_REQUIRE_HTTPS = "1";
  process.env.WEMP_WEBHOOK_TRUST_PROXY = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.WEMP_REQUIRE_HTTPS;
    else process.env.WEMP_REQUIRE_HTTPS = previous;
    if (previousTrustProxy === undefined) delete process.env.WEMP_WEBHOOK_TRUST_PROXY;
    else process.env.WEMP_WEBHOOK_TRUST_PROXY = previousTrustProxy;
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-https-forwarded-trusted-${uid}`,
    webhookPath: `/wemp-https-forwarded-trusted-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildSubscribeEventXml({
      toUser: "gh_xxx",
      fromUser: `open-https-forwarded-trusted-${uid}`,
      createTime: "1710002710",
      msgId: `msg-https-forwarded-trusted-${uid}`,
    }),
    timestamp: "1710002710",
    nonce: "nonce-https-forwarded-trusted",
    headers: {
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(result.status, 200);
  assert.match(result.body, /欢迎关注/);
});

test("webhook rejects expired timestamp in plaintext and encrypted flows", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 3_600);

  const plaintextAccount = accountFixture({
    accountId: `acc-expired-plain-${uid}`,
    webhookPath: `/wemp-expired-plain-${uid}`,
  });
  registerWempWebhook(plaintextAccount);
  t.after(() => {
    unregisterWempWebhook(plaintextAccount);
  });

  const plainResult = await postWebhook({
    baseUrl: server.baseUrl,
    account: plaintextAccount,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-expired-plain-${uid}`,
      createTime: expiredTimestamp,
      msgId: `msg-expired-plain-${uid}`,
      content: "expired",
    }),
    timestamp: expiredTimestamp,
    allowStaleTimestamp: true,
    nonce: `nonce-expired-plain-${uid}`,
  });
  assert.equal(plainResult.status, 403);
  assert.equal(plainResult.body, "Invalid signature");

  const encryptedAccount = accountFixture({
    accountId: `acc-expired-encrypted-${uid}`,
    webhookPath: `/wemp-expired-encrypted-${uid}`,
  });
  encryptedAccount.encodingAESKey = TEST_ENCODING_AES_KEY;
  registerWempWebhook(encryptedAccount);
  t.after(() => {
    unregisterWempWebhook(encryptedAccount);
  });

  const encryptedPayload = buildEncryptedWebhookPayload({
    account: encryptedAccount,
    plainXml: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-expired-encrypted-${uid}`,
      createTime: expiredTimestamp,
      msgId: `msg-expired-encrypted-${uid}`,
      content: "expired",
    }),
    timestamp: expiredTimestamp,
    nonce: `nonce-expired-encrypted-${uid}`,
  });
  const encryptedResult = await postWebhook({
    baseUrl: server.baseUrl,
    account: encryptedAccount,
    body: encryptedPayload.body,
    timestamp: expiredTimestamp,
    allowStaleTimestamp: true,
    nonce: `nonce-expired-encrypted-${uid}`,
    msgSignature: encryptedPayload.msgSignature,
  });
  assert.equal(encryptedResult.status, 403);
  assert.equal(encryptedResult.body, "Invalid signature");
});

test("webhook rejects replayed requests in plaintext and encrypted flows", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;

  const plaintextAccount = accountFixture({
    accountId: `acc-replay-plain-${uid}`,
    webhookPath: `/wemp-replay-plain-${uid}`,
  });
  registerWempWebhook(plaintextAccount);
  t.after(() => {
    unregisterWempWebhook(plaintextAccount);
  });
  const plainTimestamp = String(Math.floor(Date.now() / 1000));
  const plainNonce = `nonce-replay-plain-${uid}`;
  const plainSignature = sign(plaintextAccount.token, plainTimestamp, plainNonce);
  const plainBody = buildSubscribeEventXml({
    toUser: "gh_xxx",
    fromUser: `open-replay-plain-${uid}`,
    createTime: plainTimestamp,
    msgId: `msg-replay-plain-${uid}`,
  });

  const plainFirst = await postWebhook({
    baseUrl: server.baseUrl,
    account: plaintextAccount,
    body: plainBody,
    timestamp: plainTimestamp,
    nonce: plainNonce,
    signature: plainSignature,
  });
  assert.equal(plainFirst.status, 200);

  const plainReplay = await postWebhook({
    baseUrl: server.baseUrl,
    account: plaintextAccount,
    body: plainBody,
    timestamp: plainTimestamp,
    nonce: plainNonce,
    signature: plainSignature,
  });
  assert.equal(plainReplay.status, 403);
  assert.equal(plainReplay.body, "Invalid signature");

  const encryptedAccount = accountFixture({
    accountId: `acc-replay-encrypted-${uid}`,
    webhookPath: `/wemp-replay-encrypted-${uid}`,
  });
  encryptedAccount.encodingAESKey = TEST_ENCODING_AES_KEY;
  registerWempWebhook(encryptedAccount);
  t.after(() => {
    unregisterWempWebhook(encryptedAccount);
  });
  const encryptedTimestamp = String(Math.floor(Date.now() / 1000));
  const encryptedNonce = `nonce-replay-encrypted-${uid}`;
  const encryptedPayload = buildEncryptedWebhookPayload({
    account: encryptedAccount,
    plainXml: buildSubscribeEventXml({
      toUser: "gh_xxx",
      fromUser: `open-replay-encrypted-${uid}`,
      createTime: encryptedTimestamp,
      msgId: `msg-replay-encrypted-${uid}`,
    }),
    timestamp: encryptedTimestamp,
    nonce: encryptedNonce,
  });

  const encryptedFirst = await postWebhook({
    baseUrl: server.baseUrl,
    account: encryptedAccount,
    body: encryptedPayload.body,
    timestamp: encryptedTimestamp,
    nonce: encryptedNonce,
    msgSignature: encryptedPayload.msgSignature,
  });
  assert.equal(encryptedFirst.status, 200);

  const encryptedReplay = await postWebhook({
    baseUrl: server.baseUrl,
    account: encryptedAccount,
    body: encryptedPayload.body,
    timestamp: encryptedTimestamp,
    nonce: encryptedNonce,
    msgSignature: encryptedPayload.msgSignature,
  });
  assert.equal(encryptedReplay.status, 403);
  assert.equal(encryptedReplay.body, "Invalid signature");
});

test("encrypted webhook rejects invalid query signature before body processing", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-encrypted-signature-${uid}`,
    webhookPath: `/wemp-encrypted-signature-${uid}`,
  });
  account.encodingAESKey = TEST_ENCODING_AES_KEY;
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-encrypted-signature-${uid}`;
  const payload = buildEncryptedWebhookPayload({
    account,
    plainXml: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-encrypted-signature-${uid}`,
      createTime: timestamp,
      msgId: `msg-encrypted-signature-${uid}`,
      content: "hello",
    }),
    timestamp,
    nonce,
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: payload.body,
    timestamp,
    nonce,
    signature: "invalid-signature",
    msgSignature: payload.msgSignature,
  });
  assert.equal(result.status, 403);
  assert.equal(result.body, "Invalid signature");
});

test("webhook returns 413 when request body exceeds limit", async (t) => {
  const previousLimit = process.env.WEMP_WEBHOOK_MAX_BODY_BYTES;
  process.env.WEMP_WEBHOOK_MAX_BODY_BYTES = "1024";
  t.after(() => {
    if (previousLimit === undefined) delete process.env.WEMP_WEBHOOK_MAX_BODY_BYTES;
    else process.env.WEMP_WEBHOOK_MAX_BODY_BYTES = previousLimit;
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-body-limit-${uid}`,
    webhookPath: `/wemp-body-limit-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: `open-body-limit-${uid}`,
      createTime: "1710003001",
      msgId: `msg-body-limit-${uid}`,
      content: "x".repeat(2_048),
    }),
    timestamp: "1710003001",
    nonce: `nonce-body-limit-${uid}`,
  });
  assert.equal(result.status, 413);
  assert.equal(result.body, "Payload Too Large");
});

test("webhook returns 408 when request body read times out", async (t) => {
  const previousTimeout = process.env.WEMP_WEBHOOK_BODY_READ_TIMEOUT_MS;
  process.env.WEMP_WEBHOOK_BODY_READ_TIMEOUT_MS = "200";
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.WEMP_WEBHOOK_BODY_READ_TIMEOUT_MS;
    else process.env.WEMP_WEBHOOK_BODY_READ_TIMEOUT_MS = previousTimeout;
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-body-timeout-${uid}`,
    webhookPath: `/wemp-body-timeout-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });
  const timestamp = String(Math.floor(Date.now() / 1000));

  const result = await postWebhookWithOpenBody({
    baseUrl: server.baseUrl,
    account,
    timestamp,
    nonce: `nonce-body-timeout-${uid}`,
    bodyPrefix: "<xml>",
    headers: {
      "content-length": "1024",
    },
  });
  assert.equal(result.status, 408);
  assert.equal(result.body, "Request Timeout");
});

test("valid text webhook request returns success when inbound dispatch is accepted", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-success-${uid}`;
  const account = accountFixture({
    accountId: `acc-success-${uid}`,
    webhookPath: `/wemp-success-${uid}`,
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

  const result = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710003000",
      msgId: `msg-success-${uid}`,
      content: "hello world",
    }),
    timestamp: "1710003000",
    nonce: "nonce-success",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.ok(captured);
  assert.equal(captured?.["targetAgentId"], "main");
  assert.equal(captured?.["userId"], openId);
});

test("webhook applies per-user request rate limiting", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-rate-${uid}`;
  const account = accountFixture({
    accountId: `acc-rate-${uid}`,
    webhookPath: `/wemp-rate-${uid}`,
    allowFrom: [openId],
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  setWempRuntime({
    channel: {
      dispatchInbound: async () => {},
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  let last: { status: number; body: string } | null = null;
  for (let i = 0; i <= 20; i += 1) {
    last = await postWebhook({
      baseUrl: server.baseUrl,
      account,
      body: buildTextMessageXml({
        toUser: "gh_xxx",
        fromUser: openId,
        createTime: String(1710010000 + i),
        msgId: `msg-rate-${uid}-${i}`,
        content: `hello-${i}`,
      }),
      timestamp: String(1710010000 + i),
      nonce: `nonce-rate-${i}`,
    });
  }

  assert.ok(last);
  assert.equal(last!.status, 200);
  assert.match(last!.body, /请求过于频繁，请稍后再试。/);
});

test("webhook click assistant actions toggle state and status copy", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-assistant-${uid}`;
  const account = accountFixture({
    accountId: `acc-assistant-${uid}`,
    webhookPath: `/wemp-assistant-${uid}`,
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const off = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildClickEventXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011000",
      msgId: `msg-assistant-off-${uid}`,
      eventKey: "assistant_off",
    }),
    timestamp: "1710011000",
    nonce: "nonce-assistant-off",
  });
  assert.equal(off.status, 200);
  assert.match(off.body, /AI 助手已关闭。/);

  const statusOff = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildClickEventXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011001",
      msgId: `msg-assistant-status-off-${uid}`,
      eventKey: "assistant_status",
    }),
    timestamp: "1710011001",
    nonce: "nonce-assistant-status-off",
  });
  assert.equal(statusOff.status, 200);
  assert.match(statusOff.body, /AI 助手当前状态：已关闭。/);

  const on = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildClickEventXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011002",
      msgId: `msg-assistant-on-${uid}`,
      eventKey: "assistant_on",
    }),
    timestamp: "1710011002",
    nonce: "nonce-assistant-on",
  });
  assert.equal(on.status, 200);
  assert.match(on.body, /AI 助手已开启。/);

  const statusOn = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildClickEventXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011003",
      msgId: `msg-assistant-status-on-${uid}`,
      eventKey: "assistant_status",
    }),
    timestamp: "1710011003",
    nonce: "nonce-assistant-status-on",
  });
  assert.equal(statusOn.status, 200);
  assert.match(statusOn.body, /AI 助手当前状态：已开启。/);
});

test("webhook handoff mode blocks AI dispatch until resume command", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const notifyFile = path.join(DATA_DIR, "handoff-notify.json");
  const notifySnapshot = snapshotFile(notifyFile);
  writeFileSync(notifyFile, "[]", "utf8");
  consumeHandoffNotifications(1000);
  t.after(() => {
    restoreFile(notifyFile, notifySnapshot);
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-handoff-${uid}`;
  const account = accountFixture({
    accountId: `acc-handoff-${uid}`,
    webhookPath: `/wemp-handoff-${uid}`,
    allowFrom: [openId],
  });
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  let dispatchCalls = 0;
  let lastPayload: Record<string, unknown> | null = null;
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        dispatchCalls += 1;
        lastPayload = payload;
      },
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  const handoff = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildClickEventXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011500",
      msgId: `msg-handoff-on-${uid}`,
      eventKey: "handoff",
    }),
    timestamp: "1710011500",
    nonce: "nonce-handoff-on",
  });
  assert.equal(handoff.status, 200);
  assert.match(handoff.body, /人工接管模式/);

  const blocked = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011501",
      msgId: `msg-handoff-blocked-${uid}`,
      content: "hello while handoff",
    }),
    timestamp: "1710011501",
    nonce: "nonce-handoff-blocked",
  });
  assert.equal(blocked.status, 200);
  assert.match(blocked.body, /转人工处理/);
  assert.equal(dispatchCalls, 0);

  const resume = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011502",
      msgId: `msg-handoff-resume-${uid}`,
      content: "恢复AI",
    }),
    timestamp: "1710011502",
    nonce: "nonce-handoff-resume",
  });
  assert.equal(resume.status, 200);
  assert.match(resume.body, /已恢复 AI 助手服务/);
  assert.equal(dispatchCalls, 0);

  const resumed = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710011503",
      msgId: `msg-handoff-resumed-${uid}`,
      content: "hello after resume",
    }),
    timestamp: "1710011503",
    nonce: "nonce-handoff-resumed",
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body, "success");
  assert.equal(dispatchCalls, 1);
  assert.equal(lastPayload?.["userId"], openId);
  assert.equal(lastPayload?.["text"], "hello after resume");
  const notifications = JSON.parse(readFileSync(notifyFile, "utf8")) as Array<{
    type?: string;
    deliveries?: { ticket?: { endpoint?: string } };
  }>;
  const recent = notifications.slice(-2);
  assert.deepEqual(
    recent.map((item) => item.type),
    ["activated", "resumed"],
  );
  assert.equal(recent[0]?.deliveries?.ticket?.endpoint, "https://tickets.example.com/handoff");
  assert.equal(recent[1]?.deliveries?.ticket?.endpoint, "https://tickets.example.com/handoff");
});

test("webhook usage_status returns usage lines with limits", async (t) => {
  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  const uid = `${Date.now()}-${Math.random()}`;
  const openId = `open-usage-${uid}`;
  const account = accountFixture({
    accountId: `acc-usage-${uid}`,
    webhookPath: `/wemp-usage-${uid}`,
  });
  account.features.usageLimit = {
    enabled: true,
    dailyMessages: 5,
    dailyTokens: 500,
    exemptPaired: false,
  };
  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const inbound1 = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710012000",
      msgId: `msg-usage-1-${uid}`,
      content: "hello-1",
    }),
    timestamp: "1710012000",
    nonce: "nonce-usage-1",
  });
  assert.equal(inbound1.status, 200);

  const inbound2 = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710012001",
      msgId: `msg-usage-2-${uid}`,
      content: "hello-2",
    }),
    timestamp: "1710012001",
    nonce: "nonce-usage-2",
  });
  assert.equal(inbound2.status, 200);

  const usageStatus = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildClickEventXml({
      toUser: "gh_xxx",
      fromUser: openId,
      createTime: "1710012002",
      msgId: `msg-usage-status-${uid}`,
      eventKey: "usage_status",
    }),
    timestamp: "1710012002",
    nonce: "nonce-usage-status",
  });

  assert.equal(usageStatus.status, 200);
  assert.match(usageStatus.body, /今日消息数：2 \/ 5/);
  assert.match(usageStatus.body, /今日 token 数：\d+ \/ 500/);
});
