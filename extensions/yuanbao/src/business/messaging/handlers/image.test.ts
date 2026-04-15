/**
 * messaging/handlers/image.ts 单元测试
 *
 * 测试范围：imageHandler 的 extract 和 buildMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "../context.js";
import { imageHandler } from "./image.js";
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
  return { rawBody: "", isAtBot: false, medias: [], mentions: [] };
}

// ============ extract ============

void test("imageHandler extract 提取图片 URL 到媒体列表", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMImageElem",
    msg_content: {
      image_info_array: [
        { type: 1, url: "https://example.com/original.png" },
        { type: 2, url: "https://example.com/medium.png" },
      ],
    },
  };

  const result = imageHandler.extract(ctx, elem, resData);
  assert.equal(result, "[image1]");
  assert.equal(resData.medias.length, 1);
  // 优先取中间图（index 1）
  assert.equal(resData.medias[0].url, "https://example.com/medium.png");
  assert.equal(resData.medias[0].mediaType, "image");
});

void test("imageHandler extract 无 URL 返回 undefined", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMImageElem",
    msg_content: { image_info_array: [] },
  };

  assert.equal(imageHandler.extract(ctx, elem, resData), undefined);
  assert.equal(resData.medias.length, 0);
});

// ============ buildMsgBody ============

void test("imageHandler buildMsgBody 构造图片消息", () => {
  const result = imageHandler.buildMsgBody!({ url: "https://example.com/img.png" });
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMImageElem");
  assert.ok(result[0].msg_content.image_info_array);
});
