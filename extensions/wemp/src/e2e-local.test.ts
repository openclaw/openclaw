import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import test from "node:test";
import { sendText } from "../src/http.js";
import { approvePairingCode, revokePairing } from "../src/pairing.js";
import { clearWempRuntime, setWempRuntime } from "../src/runtime.js";
import { getWempDataRoot } from "../src/storage.js";
import type { ResolvedWempAccount } from "../src/types.js";
import {
  handleRegisteredWebhookRequest,
  registerWempWebhook,
  unregisterWempWebhook,
} from "../src/webhook.js";

const DATA_DIR = getWempDataRoot();

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
      assistantToggle: { enabled: true, defaultEnabled: false },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: {
        enabled: true,
        contact: "客服微信: abc",
        message: "如需人工支持，请联系：{{contact}}",
      },
      welcome: { enabled: true, subscribeText: "欢迎关注" },
    },
    config: {},
  };
}

function sign(token: string, timestamp: string, nonce: string): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

function extractXmlCdata(xml: string, tag: string): string {
  return new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`, "s").exec(xml)?.[1] || "";
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
  const signature = sign(params.account.token, params.timestamp, params.nonce);
  const url = new URL(params.account.webhookPath, params.baseUrl);
  url.searchParams.set("signature", signature);
  url.searchParams.set("timestamp", params.timestamp);
  url.searchParams.set("nonce", params.nonce);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/xml; charset=utf-8",
    },
    body: params.body,
  });
  return {
    status: response.status,
    body: await response.text(),
  };
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

test("local e2e: unpaired inbound -> pairing prompt -> approve -> next inbound dispatches to paired agent", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const pendingFile = path.join(DATA_DIR, "pairing-pending.json");
  const approvedFile = path.join(DATA_DIR, "pairing-approved.json");
  const notifyFile = path.join(DATA_DIR, "pairing-notify.json");
  const pendingSnapshot = snapshotFile(pendingFile);
  const approvedSnapshot = snapshotFile(approvedFile);
  const notifySnapshot = snapshotFile(notifyFile);

  const uid = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const accountId = `acc-e2e-local-${uid}`;
  const openId = `open-e2e-local-${uid}`;
  const account = accountFixture({
    accountId,
    webhookPath: `/wemp-e2e-local-${uid}`,
  });

  t.after(() => {
    revokePairing(accountId, openId);
    restoreFile(pendingFile, pendingSnapshot);
    restoreFile(approvedFile, approvedSnapshot);
    restoreFile(notifyFile, notifySnapshot);
    rmSync(path.join(DATA_DIR, "usage-limit", encodeURIComponent(accountId)), {
      recursive: true,
      force: true,
    });
  });

  const server = await startWebhookServer();
  t.after(async () => {
    await server.close();
  });

  registerWempWebhook(account);
  t.after(() => {
    unregisterWempWebhook(account);
  });

  const dispatched: Array<Record<string, unknown>> = [];
  setWempRuntime({
    channel: {
      dispatchInbound: async (payload: Record<string, unknown>) => {
        dispatched.push(payload);
      },
    },
  } as any);
  t.after(() => {
    clearWempRuntime();
  });

  const firstInbound = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_e2e",
      fromUser: openId,
      createTime: "1711000001",
      msgId: `msg-e2e-1-${uid}`,
      content: "第一条消息",
    }),
    timestamp: "1711000001",
    nonce: "nonce-e2e-1",
  });

  assert.equal(firstInbound.status, 200);
  assert.match(firstInbound.body, /<xml>/);
  const pairingPrompt = extractXmlCdata(firstInbound.body, "Content");
  assert.match(pairingPrompt, /当前 AI 助手未开启，请先完成配对后继续使用。/);
  assert.match(pairingPrompt, /审批提示：openclaw pairing approve wemp \d{6}/);
  const pairingCode = /配对码：(\d{6})/.exec(pairingPrompt)?.[1];
  assert.ok(pairingCode);
  assert.equal(dispatched.length, 0);

  const approved = approvePairingCode(pairingCode);
  assert.equal(approved.ok, true);
  assert.equal(approved.accountId, accountId);
  assert.equal(approved.openId, openId);

  const secondInbound = await postWebhook({
    baseUrl: server.baseUrl,
    account,
    body: buildTextMessageXml({
      toUser: "gh_e2e",
      fromUser: openId,
      createTime: "1711000002",
      msgId: `msg-e2e-2-${uid}`,
      content: "第二条消息",
    }),
    timestamp: "1711000002",
    nonce: "nonce-e2e-2",
  });

  assert.equal(secondInbound.status, 200);
  assert.equal(secondInbound.body, "success");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.targetAgentId, "main");
  assert.equal(dispatched[0]?.userId, openId);
  assert.equal(dispatched[0]?.text, "第二条消息");
});
