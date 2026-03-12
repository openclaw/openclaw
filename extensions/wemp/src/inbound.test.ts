import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { isAssistantEnabled } from "../src/features/assistant-toggle.js";
import { consumeHandoffNotifications } from "../src/features/handoff-notify.js";
import {
  estimateUsageTokens,
  handleEventAction,
  handleInboundMessage,
  handleSubscribeEvent,
  normalizeInboundText,
  parseWechatMessage,
  resolveInboundAgent,
  sanitizeInboundUserText,
} from "../src/inbound.js";
import type { ParsedWechatMessage } from "../src/inbound.js";
import { getWempDataRoot } from "../src/storage.js";
import type { ResolvedWempAccount } from "../src/types.js";

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

function accountFixture(accountId: string): ResolvedWempAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: "app",
    appSecret: "secret",
    token: "token",
    webhookPath: "/wemp",
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: true, defaultEnabled: false },
      usageLimit: { enabled: true, dailyMessages: 5, dailyTokens: 500, exemptPaired: false },
      routeGuard: { enabled: true, unpairedAllowedAgents: ["wemp-kf"] },
      handoff: {
        enabled: true,
        contact: "客服微信: abc",
        message: "如需人工支持，请联系：{{contact}}",
        ticketWebhook: {
          enabled: true,
          endpoint: "https://tickets.example.com/handoff",
          events: ["activated"],
        },
      },
      welcome: { enabled: true, subscribeText: "欢迎" },
    },
    config: {},
  };
}

test("resolveInboundAgent falls back when unpaired agent is not in allowed list", () => {
  const account = accountFixture(`acc-route-guard-fallback-${Date.now()}-${Math.random()}`);
  account.routing.unpairedAgent = "custom-kf";
  account.features.routeGuard = { enabled: true, unpairedAllowedAgents: ["wemp-kf", "backup-kf"] };

  const agentId = resolveInboundAgent(account, {
    openId: "openid-route-guard-1",
    text: "hello",
    paired: false,
  });

  assert.equal(agentId, "wemp-kf");
});

test("resolveInboundAgent keeps unpaired agent when it is in allowed list", () => {
  const account = accountFixture(`acc-route-guard-keep-${Date.now()}-${Math.random()}`);
  account.routing.unpairedAgent = "custom-kf";
  account.features.routeGuard = { enabled: true, unpairedAllowedAgents: ["wemp-kf", "custom-kf"] };

  const agentId = resolveInboundAgent(account, {
    openId: "openid-route-guard-2",
    text: "hello",
    paired: false,
  });

  assert.equal(agentId, "custom-kf");
});

test("resolveInboundAgent does not affect paired routing", () => {
  const account = accountFixture(`acc-route-guard-paired-${Date.now()}-${Math.random()}`);
  account.routing.pairedAgent = "main-enterprise";
  account.routing.unpairedAgent = "custom-kf";
  account.features.routeGuard = { enabled: true, unpairedAllowedAgents: ["wemp-kf"] };

  const agentId = resolveInboundAgent(account, {
    openId: "openid-route-guard-3",
    text: "hello",
    paired: true,
  });

  assert.equal(agentId, "main-enterprise");
});

test("parseWechatMessage parses text xml", () => {
  const xml = `<xml>
<ToUserName><![CDATA[to]]></ToUserName>
<FromUserName><![CDATA[from]]></FromUserName>
<CreateTime>1710000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[hello]]></Content>
<MsgId>10001</MsgId>
</xml>`;
  const parsed = parseWechatMessage(xml);
  assert.equal(parsed.toUserName, "to");
  assert.equal(parsed.fromUserName, "from");
  assert.equal(parsed.msgType, "text");
  assert.equal(parsed.content, "hello");
  assert.equal(parsed.msgId, "10001");
});

test("parseWechatMessage parses location/link/video/file xml fields", () => {
  const locationXml = `<xml>
<ToUserName><![CDATA[to]]></ToUserName>
<FromUserName><![CDATA[from]]></FromUserName>
<CreateTime>1710000001</CreateTime>
<MsgType><![CDATA[location]]></MsgType>
<Location_X>23.134521</Location_X>
<Location_Y>113.358803</Location_Y>
<Scale>20</Scale>
<Label><![CDATA[广东省广州市海珠区]]></Label>
<Poiname><![CDATA[客村]]></Poiname>
<MsgId>10002</MsgId>
</xml>`;
  const linkXml = `<xml>
<ToUserName><![CDATA[to]]></ToUserName>
<FromUserName><![CDATA[from]]></FromUserName>
<CreateTime>1710000002</CreateTime>
<MsgType><![CDATA[link]]></MsgType>
<Title><![CDATA[OpenClaw 文档]]></Title>
<Description><![CDATA[快速入门]]></Description>
<Url><![CDATA[https://example.com/doc]]></Url>
<MsgId>10003</MsgId>
</xml>`;
  const videoXml = `<xml>
<ToUserName><![CDATA[to]]></ToUserName>
<FromUserName><![CDATA[from]]></FromUserName>
<CreateTime>1710000003</CreateTime>
<MsgType><![CDATA[video]]></MsgType>
<MediaId><![CDATA[media-123]]></MediaId>
<ThumbMediaId><![CDATA[thumb-456]]></ThumbMediaId>
<Title><![CDATA[产品演示]]></Title>
<Description><![CDATA[一分钟看完]]></Description>
<MsgId>10004</MsgId>
</xml>`;
  const fileXml = `<xml>
<ToUserName><![CDATA[to]]></ToUserName>
<FromUserName><![CDATA[from]]></FromUserName>
<CreateTime>1710000004</CreateTime>
<MsgType><![CDATA[file]]></MsgType>
<MediaId><![CDATA[file-media-1]]></MediaId>
<FileName><![CDATA[报价单.pdf]]></FileName>
<Url><![CDATA[https://example.com/file.pdf]]></Url>
<MsgId>10005</MsgId>
</xml>`;

  const location = parseWechatMessage(locationXml);
  assert.equal(location.locationX, "23.134521");
  assert.equal(location.locationY, "113.358803");
  assert.equal(location.scale, "20");
  assert.equal(location.label, "广东省广州市海珠区");
  assert.equal(location.poiName, "客村");

  const link = parseWechatMessage(linkXml);
  assert.equal(link.title, "OpenClaw 文档");
  assert.equal(link.description, "快速入门");
  assert.equal(link.url, "https://example.com/doc");

  const video = parseWechatMessage(videoXml);
  assert.equal(video.mediaId, "media-123");
  assert.equal(video.thumbMediaId, "thumb-456");
  assert.equal(video.title, "产品演示");
  assert.equal(video.description, "一分钟看完");

  const file = parseWechatMessage(fileXml);
  assert.equal(file.fileName, "报价单.pdf");
  assert.equal(file.mediaId, "file-media-1");
  assert.equal(file.url, "https://example.com/file.pdf");
});

test("normalizeInboundText handles image voice and event", () => {
  const image: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "image",
    picUrl: "https://x/y.jpg",
  };
  const voice: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "voice",
    recognition: "语音识别文本",
  };
  const event: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "event",
    event: "CLICK",
    eventKey: "assistant_on",
  };
  assert.equal(normalizeInboundText(image), "[image] https://x/y.jpg");
  assert.equal(normalizeInboundText(voice), "语音识别文本");
  assert.equal(normalizeInboundText(event), "[event] click assistant_on");
});

test("normalizeInboundText handles location link video and file", () => {
  const location: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "location",
    label: "广东省广州市海珠区",
    poiName: "客村",
    locationX: "23.134521",
    locationY: "113.358803",
    scale: "20",
  };
  const link: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "link",
    title: "OpenClaw 文档",
    description: "快速入门",
    url: "https://example.com/doc",
  };
  const video: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "video",
    title: "产品演示",
    description: "一分钟看完",
    mediaId: "media-123",
    thumbMediaId: "thumb-456",
  };
  const file: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from",
    msgType: "file",
    fileName: "报价单.pdf",
    mediaId: "file-media-1",
    url: "https://example.com/file.pdf",
  };

  assert.equal(
    normalizeInboundText(location),
    "[location] label=广东省广州市海珠区 | poi=客村 | coords=23.134521,113.358803 | scale=20",
  );
  assert.equal(
    normalizeInboundText(link),
    "[link] title=OpenClaw 文档 | desc=快速入门 | url=https://example.com/doc",
  );
  assert.equal(
    normalizeInboundText(video),
    "[video] title=产品演示 | desc=一分钟看完 | media=media-123 | thumb=thumb-456",
  );
  assert.equal(
    normalizeInboundText(file),
    "[file] name=报价单.pdf | media=file-media-1 | url=https://example.com/file.pdf",
  );
});

test("handleEventAction supports assistant_status and usage_status", () => {
  const account = accountFixture(`acc-${Date.now()}-${Math.random()}`);
  const statusMsg: ParsedWechatMessage = {
    toUserName: "to",
    fromUserName: "from-openid",
    msgType: "event",
    event: "CLICK",
    eventKey: "assistant_status",
  };
  const usageMsg: ParsedWechatMessage = {
    ...statusMsg,
    eventKey: "usage_status",
  };

  const statusAction = handleEventAction(account, statusMsg);
  assert.equal(statusAction.handled, true);
  assert.match(String(statusAction.replyText || ""), /AI 助手当前状态/);

  const usageAction = handleEventAction(account, usageMsg);
  assert.equal(usageAction.handled, true);
  assert.match(String(usageAction.replyText || ""), /今日消息数/);
});

test("handleEventAction supports handoff mode status and resume", () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const notifyFile = path.join(DATA_DIR, "handoff-notify.json");
  const notifySnapshot = snapshotFile(notifyFile);
  writeFileSync(notifyFile, "[]", "utf8");
  consumeHandoffNotifications(1000);

  const account = accountFixture(`acc-handoff-${Date.now()}-${Math.random()}`);
  const openId = `open-handoff-${Date.now()}-${Math.random()}`;
  try {
    const handoffMsg: ParsedWechatMessage = {
      toUserName: "to",
      fromUserName: openId,
      msgType: "event",
      event: "CLICK",
      eventKey: "handoff",
    };
    const statusMsg: ParsedWechatMessage = {
      ...handoffMsg,
      eventKey: "handoff_status",
    };
    const resumeMsg: ParsedWechatMessage = {
      ...handoffMsg,
      eventKey: "handoff_resume",
    };

    const handoffAction = handleEventAction(account, handoffMsg);
    assert.equal(handoffAction.handled, true);
    assert.match(String(handoffAction.replyText || ""), /人工接管模式/);

    const statusInHandoff = handleEventAction(account, statusMsg);
    assert.equal(statusInHandoff.handled, true);
    assert.match(String(statusInHandoff.replyText || ""), /人工接管中/);

    const resumeAction = handleEventAction(account, resumeMsg);
    assert.equal(resumeAction.handled, true);
    assert.match(String(resumeAction.replyText || ""), /已恢复 AI 助手服务/);

    const statusAfterResume = handleEventAction(account, statusMsg);
    assert.equal(statusAfterResume.handled, true);
    assert.match(String(statusAfterResume.replyText || ""), /AI 自动回复中/);
    const notifications = JSON.parse(readFileSync(notifyFile, "utf8")) as Array<{
      type?: string;
      openId?: string;
      reason?: string;
      deliveries?: { ticket?: { endpoint?: string } };
    }>;
    const recent = notifications.slice(-2);
    assert.deepEqual(
      recent.map((item) => item.type),
      ["activated", "resumed"],
    );
    assert.ok(recent.every((item) => item.openId === openId));
    assert.deepEqual(
      recent.map((item) => item.reason),
      ["click", "click"],
    );
    assert.equal(recent[0]?.deliveries?.ticket?.endpoint, "https://tickets.example.com/handoff");
    assert.equal(recent[1]?.deliveries?.ticket, undefined);
  } finally {
    restoreFile(notifyFile, notifySnapshot);
  }
});

test("handleSubscribeEvent respects assistant defaultEnabled=false", () => {
  const seed = `${Date.now()}-${Math.random()}`;
  const account = accountFixture(`acc-subscribe-disabled-${seed}`);
  account.features.assistantToggle.defaultEnabled = false;
  const openId = `open-subscribe-disabled-${seed}`;

  handleSubscribeEvent(account, openId);

  assert.equal(isAssistantEnabled(account.accountId, openId), false);
});

test("handleSubscribeEvent returns empty text when welcome is disabled", () => {
  const seed = `${Date.now()}-${Math.random()}`;
  const account = accountFixture(`acc-subscribe-welcome-${seed}`);
  account.features.welcome.enabled = false;

  const result = handleSubscribeEvent(account, `open-subscribe-welcome-${seed}`);

  assert.equal(result.replyText, "");
});

test("estimateUsageTokens uses utf8-size heuristic with cjk adjustment", () => {
  assert.equal(estimateUsageTokens(""), 0);
  assert.equal(estimateUsageTokens("   "), 0);
  assert.ok(estimateUsageTokens("hello world") > 0);
  assert.ok(estimateUsageTokens("你好，世界") >= estimateUsageTokens("hello"));
  assert.ok(estimateUsageTokens("a".repeat(200)) > estimateUsageTokens("a".repeat(20)));
});

test("sanitizeInboundUserText removes control chars and truncates long content", () => {
  const raw = `\u0001hello\u0002\n\n\nworld${"a".repeat(3_000)}`;
  const sanitized = sanitizeInboundUserText(raw);
  assert.match(sanitized, /^hello/);
  assert.ok(!sanitized.includes("\u0001"));
  assert.ok(!sanitized.includes("\u0002"));
  assert.ok(sanitized.includes("world"));
  assert.ok(sanitized.length <= 2_000);
});

test("handleInboundMessage applies dm policy semantics", async () => {
  const account = accountFixture(`acc-dm-policy-${Date.now()}-${Math.random()}`);
  const openId = `openid-dm-policy-${Date.now()}-${Math.random()}`;

  account.dm.policy = "open";
  account.dm.allowFrom = [];
  const openResult = await handleInboundMessage(account, {
    openId,
    text: "hello-open",
  });
  assert.equal(openResult.paired, true);

  account.dm.policy = "allowlist";
  account.dm.allowFrom = [];
  const allowlistDenied = await handleInboundMessage(account, {
    openId,
    text: "hello-allowlist-denied",
  });
  assert.equal(allowlistDenied.paired, false);

  account.dm.allowFrom = [openId];
  const allowlistAllowed = await handleInboundMessage(account, {
    openId,
    text: "hello-allowlist-allowed",
  });
  assert.equal(allowlistAllowed.paired, true);

  account.dm.policy = "disabled";
  account.dm.allowFrom = [openId];
  const disabledResult = await handleInboundMessage(account, {
    openId,
    text: "hello-disabled",
  });
  assert.equal(disabledResult.paired, false);
});
