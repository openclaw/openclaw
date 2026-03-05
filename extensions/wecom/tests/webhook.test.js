/**
 * Tests for WecomWebhook (webhook.js)
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { WecomWebhook } from "../webhook.js";
import { WecomCrypto } from "../crypto.js";
import { MessageDeduplicator } from "../utils.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOKEN = "WebhookTestToken";
// 43-char base64 key that decodes to a valid 32-byte AES key.
const ENC_KEY = "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkYWI";

const config = { token: TOKEN, encodingAesKey: ENC_KEY };

/**
 * Build a valid encrypted body + query params for testing handleMessage.
 * Returns { query, body } ready to pass to handleMessage.
 */
function buildEncryptedRequest(plainPayload) {
  const crypto = new WecomCrypto(TOKEN, ENC_KEY);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "testnonce123";
  const encrypted = crypto.encrypt(plainPayload);
  const signature = crypto.getSignature(timestamp, nonce, encrypted);
  const query = { msg_signature: signature, timestamp, nonce };
  const body = JSON.stringify({ encrypt: encrypted });
  return { query, body };
}

// ── WecomWebhook — constructor ────────────────────────────────────────────────

describe("WecomWebhook — constructor", () => {
  it("creates an instance with a valid config", () => {
    const wh = new WecomWebhook(config);
    assert.ok(wh.crypto instanceof WecomCrypto);
  });

  it("accepts an injected deduplicator", () => {
    const dedup = new MessageDeduplicator();
    const wh = new WecomWebhook(config, dedup);
    assert.equal(wh.deduplicator, dedup);
    dedup.seen.destroy();
  });

  it("exposes the DUPLICATE sentinel symbol", () => {
    assert.equal(typeof WecomWebhook.DUPLICATE, "symbol");
  });
});

// ── handleVerify ─────────────────────────────────────────────────────────────

describe("WecomWebhook — handleVerify", () => {
  let wh;
  before(() => {
    wh = new WecomWebhook(config);
  });

  it("returns null when required query params are missing", () => {
    assert.equal(wh.handleVerify({}), null);
    assert.equal(wh.handleVerify({ msg_signature: "sig" }), null);
    assert.equal(
      wh.handleVerify({ msg_signature: "sig", timestamp: "123", nonce: "abc" }),
      null,
    );
  });

  it("returns null when signature does not match", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const ts = "1234567890";
    const nonce = "nonce001";
    const echostr = crypto.encrypt("challenge-text");
    // Use a wrong signature.
    const result = wh.handleVerify({
      msg_signature: "deadbeef".repeat(5),
      timestamp: ts,
      nonce,
      echostr,
    });
    assert.equal(result, null);
  });

  it("returns the decrypted echostr when signature matches", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const ts = "9876543210";
    const nonce = "nonce002";
    const challengeText = "echo-challenge-12345";
    const echostr = crypto.encrypt(challengeText);
    const sig = crypto.getSignature(ts, nonce, echostr);

    const result = wh.handleVerify({
      msg_signature: sig,
      timestamp: ts,
      nonce,
      echostr,
    });
    assert.equal(result, challengeText);
  });
});

// ── handleMessage — invalid inputs ───────────────────────────────────────────

describe("WecomWebhook — handleMessage invalid inputs", () => {
  let wh;
  before(() => {
    wh = new WecomWebhook(config);
  });

  it("returns null when query params are missing", async () => {
    assert.equal(await wh.handleMessage({}, "{}"), null);
    assert.equal(
      await wh.handleMessage({ msg_signature: "s", timestamp: "t" }, "{}"),
      null,
    );
  });

  it("returns null when body is not valid JSON", async () => {
    const query = { msg_signature: "s", timestamp: "t", nonce: "n" };
    assert.equal(await wh.handleMessage(query, "not-json"), null);
  });

  it("returns null when body has no encrypt field", async () => {
    const query = { msg_signature: "s", timestamp: "t", nonce: "n" };
    assert.equal(await wh.handleMessage(query, JSON.stringify({ other: "field" })), null);
  });

  it("returns null when signature is wrong", async () => {
    const query = {
      msg_signature: "0".repeat(40),
      timestamp: "1111111111",
      nonce: "badnonce",
    };
    const body = JSON.stringify({ encrypt: "someEncryptedData" });
    assert.equal(await wh.handleMessage(query, body), null);
  });
});

// ── handleMessage — text message ─────────────────────────────────────────────

describe("WecomWebhook — handleMessage text messages", () => {
  let wh;
  before(() => {
    wh = new WecomWebhook(config);
  });

  it("parses a valid text message", async () => {
    const payload = JSON.stringify({
      msgtype: "text",
      msgid: "msg-text-001",
      text: { content: "Hello WeCom Bot!" },
      from: { userid: "user_alice" },
      chattype: "single",
      chatid: "",
      aibotid: "bot-abc",
      response_url: "https://example.com/response",
    });
    const { query, body } = buildEncryptedRequest(payload);
    const result = await wh.handleMessage(query, body);

    assert.ok(result !== null && result !== WecomWebhook.DUPLICATE);
    assert.equal(result.message.msgType, "text");
    assert.equal(result.message.content, "Hello WeCom Bot!");
    assert.equal(result.message.fromUser, "user_alice");
    assert.equal(result.message.chatType, "single");
    assert.equal(result.message.aibotId, "bot-abc");
    assert.equal(result.message.responseUrl, "https://example.com/response");
  });

  it("includes quote metadata when present", async () => {
    const payload = JSON.stringify({
      msgtype: "text",
      msgid: "msg-quote-001",
      text: { content: "Reply to quote" },
      from: { userid: "user_bob" },
      chattype: "single",
      quote: { msgtype: "text", text: { content: "Quoted text" } },
    });
    const { query, body } = buildEncryptedRequest(payload);
    const result = await wh.handleMessage(query, body);

    assert.ok(result.message.quote);
    assert.equal(result.message.quote.msgType, "text");
    assert.equal(result.message.quote.content, "Quoted text");
  });

  it("sets quote to null when no quote in payload", async () => {
    const payload = JSON.stringify({
      msgtype: "text",
      msgid: "msg-noquote-001",
      text: { content: "No quote" },
      from: { userid: "u1" },
    });
    const { query, body } = buildEncryptedRequest(payload);
    const result = await wh.handleMessage(query, body);
    assert.equal(result.message.quote, null);
  });
});

// ── handleMessage — duplicate detection ──────────────────────────────────────

describe("WecomWebhook — duplicate message detection", () => {
  it("returns DUPLICATE sentinel on second delivery of same msgId", async () => {
    const dedup = new MessageDeduplicator();
    const wh = new WecomWebhook(config, dedup);

    const msgId = `dup-test-${Date.now()}`;
    const payload = JSON.stringify({
      msgtype: "text",
      msgid: msgId,
      text: { content: "Duplicate test" },
      from: { userid: "u" },
    });
    const { query, body } = buildEncryptedRequest(payload);

    // First delivery → normal result.
    const first = await wh.handleMessage(query, body);
    assert.notEqual(first, WecomWebhook.DUPLICATE);
    assert.ok(first !== null);

    // Second delivery (same body / new signature is still valid) → DUPLICATE.
    const { query: q2, body: b2 } = buildEncryptedRequest(payload);
    const second = await wh.handleMessage(q2, b2);
    assert.equal(second, WecomWebhook.DUPLICATE);

    dedup.seen.destroy();
  });
});

// ── handleMessage — image message ────────────────────────────────────────────

describe("WecomWebhook — handleMessage image messages", () => {
  it("parses an image message", async () => {
    const wh = new WecomWebhook(config);
    const payload = JSON.stringify({
      msgtype: "image",
      msgid: `img-${Date.now()}`,
      image: { url: "https://file.weixin.qq.com/img/test.jpg" },
      from: { userid: "user_img" },
      chattype: "single",
    });
    const { query, body } = buildEncryptedRequest(payload);
    const result = await wh.handleMessage(query, body);

    assert.ok(result !== null && result !== WecomWebhook.DUPLICATE);
    assert.equal(result.message.msgType, "image");
    assert.equal(result.message.imageUrl, "https://file.weixin.qq.com/img/test.jpg");
    assert.equal(result.message.fromUser, "user_img");
  });
});

// ── handleMessage — event message ────────────────────────────────────────────

describe("WecomWebhook — handleMessage event messages", () => {
  it("parses an event message", async () => {
    const wh = new WecomWebhook(config);
    const payload = JSON.stringify({
      msgtype: "event",
      event: { event_type: "enter_chat" },
    });
    const { query, body } = buildEncryptedRequest(payload);
    const result = await wh.handleMessage(query, body);

    assert.ok(result !== null);
    assert.ok(result.event);
    assert.equal(result.event.event_type, "enter_chat");
  });
});

// ── handleMessage — stream continuation ──────────────────────────────────────

describe("WecomWebhook — handleMessage stream refresh", () => {
  it("parses a stream refresh request", async () => {
    const wh = new WecomWebhook(config);
    const payload = JSON.stringify({
      msgtype: "stream",
      stream: { id: "stream-id-abc" },
    });
    const { query, body } = buildEncryptedRequest(payload);
    const result = await wh.handleMessage(query, body);

    assert.ok(result !== null);
    assert.ok(result.stream);
    assert.equal(result.stream.id, "stream-id-abc");
  });
});

// ── handleMessage — unknown msgtype ──────────────────────────────────────────

describe("WecomWebhook — handleMessage unknown msgtype", () => {
  it("returns null for unsupported message types", async () => {
    const wh = new WecomWebhook(config);
    const payload = JSON.stringify({
      msgtype: "unknown_future_type",
      from: { userid: "u" },
    });
    const { query, body } = buildEncryptedRequest(payload);
    assert.equal(await wh.handleMessage(query, body), null);
  });
});

// ── buildStreamResponse ───────────────────────────────────────────────────────

describe("WecomWebhook — buildStreamResponse", () => {
  let wh;
  before(() => {
    wh = new WecomWebhook(config);
  });

  it("returns a valid JSON string", () => {
    const raw = wh.buildStreamResponse("sid-1", "content here", false, "ts", "nc");
    const parsed = JSON.parse(raw);
    assert.ok(typeof parsed.encrypt === "string");
    assert.ok(typeof parsed.msgsignature === "string");
    assert.equal(parsed.timestamp, "ts");
    assert.equal(parsed.nonce, "nc");
  });

  it("encrypted payload decrypts to correct stream object", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const raw = wh.buildStreamResponse("sid-X", "hello", true, "1234", "abcd");
    const outer = JSON.parse(raw);
    const { message } = crypto.decrypt(outer.encrypt);
    const inner = JSON.parse(message);
    assert.equal(inner.msgtype, "stream");
    assert.equal(inner.stream.id, "sid-X");
    assert.equal(inner.stream.content, "hello");
    assert.equal(inner.stream.finish, true);
  });

  it("includes msg_item when options.msgItem is provided", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const items = [{ msgtype: "image", image: { base64: "abc", md5: "def" } }];
    const raw = wh.buildStreamResponse("sid-Y", "text", true, "ts", "nc", {
      msgItem: items,
    });
    const outer = JSON.parse(raw);
    const { message } = crypto.decrypt(outer.encrypt);
    const inner = JSON.parse(message);
    assert.ok(Array.isArray(inner.stream.msg_item));
    assert.equal(inner.stream.msg_item.length, 1);
  });

  it("includes feedback.id when options.feedbackId is provided", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const raw = wh.buildStreamResponse("sid-Z", "done", true, "ts", "nc", {
      feedbackId: "fb-999",
    });
    const outer = JSON.parse(raw);
    const { message } = crypto.decrypt(outer.encrypt);
    const inner = JSON.parse(message);
    assert.equal(inner.stream.feedback.id, "fb-999");
  });

  it("omits msg_item when options.msgItem is empty", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const raw = wh.buildStreamResponse("sid-W", "text", true, "ts", "nc", {
      msgItem: [],
    });
    const outer = JSON.parse(raw);
    const { message } = crypto.decrypt(outer.encrypt);
    const inner = JSON.parse(message);
    assert.equal(inner.stream.msg_item, undefined);
  });

  it("signature in response is verifiable", () => {
    const crypto = new WecomCrypto(TOKEN, ENC_KEY);
    const ts = "5555555555";
    const nc = "sig-test-nonce";
    const raw = wh.buildStreamResponse("sid-V", "verify me", false, ts, nc);
    const outer = JSON.parse(raw);
    const expectedSig = crypto.getSignature(ts, nc, outer.encrypt);
    assert.equal(outer.msgsignature, expectedSig);
  });
});
