/**
 * 中间件 download-media 单元测试
 *
 * 测试范围：媒体下载、群聊历史媒体收集、when 条件守卫
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ============ 共享可变 mock 状态 ============

let mockDownloadResult = {
  mediaPaths: ["/tmp/img1.jpg"] as string[],
  mediaTypes: ["image"] as string[],
};

let mockRegistered = false;

function setupMocks(t: any, downloadResult?: { mediaPaths: string[]; mediaTypes: string[] }) {
  mockDownloadResult = downloadResult ?? {
    mediaPaths: ["/tmp/img1.jpg"],
    mediaTypes: ["image"],
  };
  if (!mockRegistered) {
    t.mock.module("../../utils/media.js", {
      namedExports: {
        downloadMediasToLocalFiles: async () => ({ ...mockDownloadResult }),
      },
    });
    t.mock.module("../../messaging/chat-history.js", {
      namedExports: {
        chatHistories: new Map(),
        chatMediaHistories: new Map(),
        recordMediaHistory: () => {},
      },
    });
    mockRegistered = true;
  }
}

// ============ when 条件守卫 ============

void test("download-media: when 条件 - 有媒体时执行", async (t) => {
  setupMocks(t);
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  assert.equal(downloadMedia.when!(ctx), true);
});

void test("download-media: when 条件 - 空数组仍 truthy", async (t) => {
  setupMocks(t);
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({ medias: [] });
  assert.equal(downloadMedia.when!(ctx), true);
});

// ============ handler 逻辑 ============

void test("download-media: C2C 场景 - 下载媒体并填充 mediaPaths", async (t) => {
  setupMocks(t, {
    mediaPaths: ["/tmp/img1.jpg"],
    mediaTypes: ["image"],
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  const { next, wasCalled } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/img1.jpg"]);
  assert.deepEqual(ctx.mediaTypes, ["image"]);
  assert.equal(wasCalled(), true);
});

void test("download-media: 群聊场景 - 下载媒体并填充 mediaPaths", async (t) => {
  setupMocks(t, {
    mediaPaths: ["/tmp/group-img.jpg"],
    mediaTypes: ["image"],
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [{ mediaType: "image", url: "https://example.com/group-img.jpg" }] as any,
    raw: { msg_id: "msg-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/group-img.jpg"]);
  assert.deepEqual(ctx.mediaTypes, ["image"]);
  assert.equal(wasCalled(), true);
});

void test("download-media: 无媒体时 mediaPaths 为空", async (t) => {
  setupMocks(t, {
    mediaPaths: [],
    mediaTypes: [],
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    medias: [],
  });
  const { next, wasCalled } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, []);
  assert.deepEqual(ctx.mediaTypes, []);
  assert.equal(wasCalled(), true);
});

void test("download-media: 多个媒体文件下载", async (t) => {
  setupMocks(t, {
    mediaPaths: ["/tmp/img1.jpg", "/tmp/doc.pdf"],
    mediaTypes: ["image", "file"],
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    medias: [
      { mediaType: "image", url: "https://example.com/img1.jpg" },
      { mediaType: "file", url: "https://example.com/doc.pdf" },
    ] as any,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.equal(ctx.mediaPaths.length, 2);
  assert.equal(ctx.mediaTypes.length, 2);
});
