import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingUploads,
  getPendingUpload,
  getPendingUploadCount,
  removePendingUpload,
  storePendingUpload,
} from "./pending-uploads.js";

describe("msteams pending uploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingUploads();
  });

  afterEach(() => {
    clearPendingUploads();
    vi.useRealTimers();
  });

  it("stores uploads, exposes them by id, and tracks count", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("hello"),
      filename: "hello.txt",
      contentType: "text/plain",
      conversationId: "conv-1",
    });

    expect(getPendingUploadCount()).toBe(1);
    expect(getPendingUpload(id)).toEqual(
      expect.objectContaining({
        id,
        filename: "hello.txt",
        contentType: "text/plain",
        conversationId: "conv-1",
      }),
    );
  });

  it("removes uploads explicitly and ignores empty ids", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("hello"),
      filename: "hello.txt",
      conversationId: "conv-1",
    });

    removePendingUpload(undefined);
    expect(getPendingUploadCount()).toBe(1);

    removePendingUpload(id);
    expect(getPendingUpload(id)).toBeUndefined();
    expect(getPendingUploadCount()).toBe(0);
  });

  it("expires uploads by ttl even if the timeout callback has not been observed yet", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("hello"),
      filename: "hello.txt",
      conversationId: "conv-1",
    });

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(getPendingUpload(id)).toBeUndefined();
    expect(getPendingUploadCount()).toBe(0);
  });

  it("clears all uploads for test cleanup", () => {
    storePendingUpload({
      buffer: Buffer.from("a"),
      filename: "a.txt",
      conversationId: "conv-1",
    });
    storePendingUpload({
      buffer: Buffer.from("b"),
      filename: "b.txt",
      conversationId: "conv-2",
    });

    clearPendingUploads();

    expect(getPendingUploadCount()).toBe(0);
  });
});
