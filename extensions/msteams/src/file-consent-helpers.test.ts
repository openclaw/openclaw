import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import * as pendingUploads from "./pending-uploads.js";

describe("requiresFileConsent", () => {
  const thresholdBytes = 4 * 1024 * 1024;

  it.each([
    ["personal", "application/pdf", 1000, true],
    ["personal", "image/png", 5 * 1024 * 1024, true],
    ["personal", "image/png", 1000, false],
    ["groupChat", "application/pdf", 5 * 1024 * 1024, false],
    ["channel", "application/pdf", 5 * 1024 * 1024, false],
    ["Personal", "application/pdf", 1000, true],
    ["PERSONAL", "application/pdf", 1000, true],
    [undefined, "application/pdf", 1000, false],
    ["personal", undefined, 1000, true],
    ["personal", "image/jpeg", thresholdBytes, true],
    ["personal", "image/jpeg", thresholdBytes - 1, false],
  ] as const)(
    "%s chat with %s at %i bytes requires consent: %s",
    (conversationType, contentType, bufferSize, expected) => {
      expect(
        requiresFileConsent({ conversationType, contentType, bufferSize, thresholdBytes }),
      ).toBe(expected);
    },
  );
});

describe("prepareFileConsentActivity", () => {
  const mockUploadId = "test-upload-id-123";

  beforeEach(() => {
    vi.spyOn(pendingUploads, "storePendingUpload").mockReturnValue(mockUploadId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates activity with consent card attachment", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test content"),
        filename: "test.pdf",
        contentType: "application/pdf",
      },
      conversationId: "conv123",
      description: "My file",
    });

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
    expect(result.activity.attachments).toHaveLength(1);

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, unknown>;
    expect(attachment.contentType).toBe("application/vnd.microsoft.teams.card.file.consent");
    expect(attachment.name).toBe("test.pdf");
  });

  it("stores pending upload with correct data", () => {
    const buffer = Buffer.from("test content");
    prepareFileConsentActivity({
      media: {
        buffer,
        filename: "test.pdf",
        contentType: "application/pdf",
      },
      conversationId: "conv123",
      description: "My file",
    });

    expect(pendingUploads.storePendingUpload).toHaveBeenCalledWith({
      buffer,
      filename: "test.pdf",
      contentType: "application/pdf",
      conversationId: "conv123",
    });
  });

  it("uses default description when not provided", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test"),
        filename: "document.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      conversationId: "conv456",
    });

    const attachment = expectDefined(
      (result.activity.attachments as Array<{ content: { description: string } }>)[0],
      "default file-consent attachment",
    );
    expect(attachment.content.description).toBe("File: document.docx");
  });

  it("uses provided description", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test"),
        filename: "report.pdf",
        contentType: "application/pdf",
      },
      conversationId: "conv789",
      description: "Q4 Financial Report",
    });

    const attachment = expectDefined(
      (result.activity.attachments as Array<{ content: { description: string } }>)[0],
      "described file-consent attachment",
    );
    expect(attachment.content.description).toBe("Q4 Financial Report");
  });

  it("includes uploadId in consent card context", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test"),
        filename: "file.txt",
        contentType: "text/plain",
      },
      conversationId: "conv000",
    });

    const attachment = expectDefined(
      (
        result.activity.attachments as Array<{
          content: { acceptContext: { uploadId: string } };
        }>
      )[0],
      "file-consent upload attachment",
    );
    expect(attachment.content.acceptContext.uploadId).toBe(mockUploadId);
  });

  it("handles media without contentType", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("binary data"),
        filename: "unknown.bin",
      },
      conversationId: "conv111",
    });

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
  });
});
