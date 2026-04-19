/**
 * Unit tests for download-media middleware: media download, group media history, when guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

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

void test("download-media: when guard - executes when media present", async (t) => {
  setupMocks(t);
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  assert.equal(downloadMedia.when!(ctx), true);
});

void test("download-media: when guard - empty array is still truthy", async (t) => {
  setupMocks(t);
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({ medias: [] });
  assert.equal(downloadMedia.when!(ctx), true);
});

void test("download-media: C2C - downloads media and populates mediaPaths", async (t) => {
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

void test("download-media: group - downloads media and populates mediaPaths", async (t) => {
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

void test("download-media: no media - mediaPaths is empty", async (t) => {
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

void test("download-media: multiple media files download", async (t) => {
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
