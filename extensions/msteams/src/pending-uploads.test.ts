import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPendingUpload,
  removePendingUpload,
  setPendingUploadActivityId,
  storePendingUpload,
} from "./pending-uploads.js";

const createdUploadIds = new Set<string>();

function storePendingUploadForTest(
  upload: Partial<Parameters<typeof storePendingUpload>[0]> = {},
): string {
  const id = storePendingUpload({
    buffer: Buffer.from("data"),
    filename: "file.txt",
    conversationId: "conv-1",
    ...upload,
  });
  createdUploadIds.add(id);
  return id;
}

describe("pending-uploads", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    for (const id of createdUploadIds) {
      removePendingUpload(id);
    }
    createdUploadIds.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("storePendingUpload", () => {
    it.each([0, -3_600_000, 3_600_000])(
      "expires normally despite a %dms wall-clock step",
      (step) => {
        const createdAt = Date.now();
        const id = storePendingUploadForTest();
        vi.setSystemTime(createdAt + step);
        expect(getPendingUpload(id)).toMatchObject({ filename: "file.txt", createdAt });
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        expect(getPendingUpload(id)).toBeUndefined();
      },
    );
  });

  describe("removePendingUpload", () => {
    it("clears the TTL timer so it does not fire after explicit removal", () => {
      const id = storePendingUploadForTest();

      expect(getPendingUpload(id)).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);
      removePendingUpload(id);
      expect(getPendingUpload(id)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("setPendingUploadActivityId", () => {
    it("sets the consentCardActivityId on an existing upload", () => {
      const id = storePendingUploadForTest();

      expect(getPendingUpload(id)?.consentCardActivityId).toBeUndefined();

      setPendingUploadActivityId(id, "activity-xyz");
      expect(getPendingUpload(id)?.consentCardActivityId).toBe("activity-xyz");
    });
  });

  describe("getPendingUpload", () => {
    it("returns undefined for undefined id", () => {
      expect(getPendingUpload(undefined)).toBeUndefined();
    });

    it("returns undefined when entry is past TTL but timer has not yet fired", () => {
      const id = storePendingUploadForTest();

      const base = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(base + 5 * 60 * 1000 + 1);
      expect(getPendingUpload(id)).toBeUndefined();
    });
  });
});
