/**
 * messaging/handlers/text.ts unit tests.
 *
 * Test scope: textHandler extract and buildMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "../context.js";
import { textHandler } from "./text.js";
import type { ExtractTextFromMsgBodyResult } from "./types.js";

// Construct minimal mock context
function makeMockCtx(botId = "bot-001"): MessageHandlerContext {
  return {
    account: { botId },
    config: {},
    core: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
    wsClient: {},
  } as unknown as MessageHandlerContext;
}

function makeResData(): ExtractTextFromMsgBodyResult {
  return { rawBody: "", isAtBot: false, medias: [], mentions: [], linkUrls: [] };
}

void test("textHandler extract extracts text", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const result = textHandler.extract(
    ctx,
    { msg_type: "TIMTextElem", msg_content: { text: "hello world" } },
    resData,
  );
  assert.equal(result, "hello world");
});

void test("textHandler extract returns undefined for empty text", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  assert.equal(
    textHandler.extract(ctx, { msg_type: "TIMTextElem", msg_content: { text: "" } }, resData),
    undefined,
  );
  assert.equal(
    textHandler.extract(ctx, { msg_type: "TIMTextElem", msg_content: {} }, resData),
    undefined,
  );
});

void test("textHandler buildMsgBody constructs text message", () => {
  const result = textHandler.buildMsgBody!({ text: "test message" });
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMTextElem");
  assert.equal(result[0].msg_content.text, "test message");
});
