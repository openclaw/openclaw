import { describe, expect, it } from "vitest";
import { redactImageDataForDiagnostics } from "./payload-redaction.js";

const imageBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) },
};
const redactedImageBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "<redacted:3kb>" },
};
const directImageBlock = {
  type: "image",
  data: "A".repeat(4096),
  mimeType: "image/png",
};
const redactedDirectImageBlock = {
  type: "image",
  data: "<redacted:3kb>",
  mimeType: "image/png",
};
const textBlock = { type: "text", text: "hello" };

describe("redactImageDataForDiagnostics", () => {
  describe("object with messages property", () => {
    it("redacts base64 image blocks inside messages", () => {
      const payload = {
        model: "claude-3",
        messages: [{ role: "user", content: [imageBlock] }],
      };
      const result = redactImageDataForDiagnostics(payload) as typeof payload;
      expect((result.messages[0].content as unknown[])[0]).toEqual(redactedImageBlock);
    });

    it("redacts direct image data blocks inside messages", () => {
      const payload = {
        model: "claude-3",
        messages: [{ role: "user", content: [directImageBlock] }],
      };
      const result = redactImageDataForDiagnostics(payload) as typeof payload;
      expect((result.messages[0].content as unknown[])[0]).toEqual(redactedDirectImageBlock);
    });

    it("returns the same reference when no images are present", () => {
      const payload = {
        messages: [{ role: "user", content: [textBlock] }],
      };
      expect(redactImageDataForDiagnostics(payload)).toBe(payload);
    });

    it("returns unchanged when messages is absent", () => {
      const payload = { model: "claude-3" };
      expect(redactImageDataForDiagnostics(payload)).toBe(payload);
    });
  });

  describe("array passed directly (cache-trace path)", () => {
    it("redacts base64 image blocks in an array of messages", () => {
      const messages = [{ role: "user", content: [imageBlock] }];
      const result = redactImageDataForDiagnostics(messages) as typeof messages;
      expect((result[0].content as unknown[])[0]).toEqual(redactedImageBlock);
    });

    it("returns the same reference when no images are present", () => {
      const messages = [{ role: "user", content: [textBlock] }];
      expect(redactImageDataForDiagnostics(messages)).toBe(messages);
    });

    it("handles an empty array", () => {
      const messages: unknown[] = [];
      expect(redactImageDataForDiagnostics(messages)).toBe(messages);
    });
  });

  describe("options.images (non-messages payload path)", () => {
    it("redacts base64 image data in options.images", () => {
      const payload = {
        options: {
          images: [imageBlock],
        },
      };
      const result = redactImageDataForDiagnostics(payload) as typeof payload;
      expect((result.options.images as unknown[])[0]).toEqual(redactedImageBlock);
    });

    it("redacts direct image data in options.images", () => {
      const payload = {
        options: {
          images: [directImageBlock],
        },
      };
      const result = redactImageDataForDiagnostics(payload) as typeof payload;
      expect((result.options.images as unknown[])[0]).toEqual(redactedDirectImageBlock);
    });

    it("returns same reference when options.images contains no base64 blocks", () => {
      const payload = { options: { images: [{ type: "text", text: "hi" }] } };
      expect(redactImageDataForDiagnostics(payload)).toBe(payload);
    });

    it("does not redact non-image blocks with data fields", () => {
      const payload = { options: { images: [{ type: "text", data: "not-image-data" }] } };
      expect(redactImageDataForDiagnostics(payload)).toBe(payload);
    });

    it("redacts images in both messages and options when both are present", () => {
      const payload = {
        messages: [{ role: "user", content: [imageBlock] }],
        options: { images: [imageBlock] },
      };
      const result = redactImageDataForDiagnostics(payload) as typeof payload;
      expect((result.messages[0].content as unknown[])[0]).toEqual(redactedImageBlock);
      expect((result.options.images as unknown[])[0]).toEqual(redactedImageBlock);
    });

    it("returns same reference when payload has no messages and no images", () => {
      const payload = { model: "claude-3" };
      expect(redactImageDataForDiagnostics(payload)).toBe(payload);
    });
  });

  describe("non-object inputs", () => {
    it("returns null unchanged", () => {
      expect(redactImageDataForDiagnostics(null)).toBeNull();
    });

    it("returns a string unchanged", () => {
      expect(redactImageDataForDiagnostics("raw")).toBe("raw");
    });
  });

  describe("cycle handling", () => {
    it("replaces cycle back-references with a safe placeholder", () => {
      const payload: { self?: unknown; data: { type: string; text: string } } = {
        data: { type: "text", text: "hello" },
      };
      payload.self = payload;

      const result = redactImageDataForDiagnostics(payload) as {
        self: unknown;
        data: { type: string; text: string };
      };
      expect(result.self).toBe("[Circular]");
      expect(result.data).toEqual(payload.data);
    });

    it("redacts cyclic payloads without leaking raw image data through back-edges", () => {
      const payload: {
        self?: unknown;
        options: { images: Array<{ type: string; data: string; mimeType: string }> };
      } = {
        options: { images: [directImageBlock] },
      };
      payload.self = payload;

      const result = redactImageDataForDiagnostics(payload) as typeof payload;
      expect(result.options.images[0]).toEqual(redactedDirectImageBlock);
      expect(result.self).toBe("[Circular]");
      expect(JSON.stringify(result)).not.toContain("A".repeat(64));
    });
  });
});
