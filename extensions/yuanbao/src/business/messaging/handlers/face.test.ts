/**
 * messaging/handlers/face.ts unit tests.
 *
 * Test scope: faceHandler extract and buildMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "../context.js";
import { faceHandler } from "./face.js";
import type { ExtractTextFromMsgBodyResult } from "./types.js";

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

// ============ extract ============

void test("faceHandler extract parses sticker name", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMFaceElem",
    msg_content: {
      index: 0,
      data: JSON.stringify({ package_id: "1004", sticker_id: "51675", name: "喜悦情绪" }),
    },
  };

  const result = faceHandler.extract(ctx, elem, resData);
  assert.equal(result, "[EMOJI: 喜悦情绪]");
});

void test("faceHandler extract returns generic placeholder without data", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = { msg_type: "TIMFaceElem", msg_content: {} };
  assert.equal(faceHandler.extract(ctx, elem, resData), "[EMOJI]");
});

void test("faceHandler extract returns generic placeholder for invalid JSON", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = { msg_type: "TIMFaceElem", msg_content: { data: "{invalid}" } };
  assert.equal(faceHandler.extract(ctx, elem, resData), "[EMOJI]");
});

// ============ buildMsgBody ============

void test("faceHandler buildMsgBody constructs sticker message", () => {
  const result = faceHandler.buildMsgBody!({
    package_id: "1004",
    sticker_id: "51675",
    name: "喜悦情绪",
    index: 0,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMFaceElem");
  assert.equal(result[0].msg_content.index, 0);
  const parsed = JSON.parse(result[0].msg_content.data!);
  assert.equal(parsed.name, "喜悦情绪");
  assert.equal(parsed.sticker_id, "51675");
});
