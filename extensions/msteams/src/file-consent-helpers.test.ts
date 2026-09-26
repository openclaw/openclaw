import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import * as pendingUploads from "./pending-uploads.js";

describe("requiresFileConsent", () => {
  const thresholdBytes = 4 * 1024 * 1024;

  it.each([
    ["personal", "application/pdf", 1000, true],
    ["groupChat", "application/pdf", 5 * 1024 * 1024, false],
    ["Personal", "application/pdf", 1000, true],
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
  const media = {
    buffer: Buffer.from("test content"),
    filename: "test.pdf",
    contentType: "application/pdf",
  };
  const prepare = (description?: string) =>
    prepareFileConsentActivity({ media, conversationId: "conv123", description });

  beforeEach(() => {
    vi.spyOn(pendingUploads, "storePendingUpload").mockReturnValue(mockUploadId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates activity with consent card attachment", () => {
    const result = prepare("My file");

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
    expect(result.activity.attachments).toHaveLength(1);

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, unknown>;
    expect(attachment.contentType).toBe("application/vnd.microsoft.teams.card.file.consent");
    expect(attachment.name).toBe("test.pdf");
  });

  it("stores pending upload with correct data", () => {
    prepare("My file");

    expect(pendingUploads.storePendingUpload).toHaveBeenCalledWith({
      ...media,
      conversationId: "conv123",
    });
  });

  it("uses default description when not provided", () => {
    const result = prepare();
    const attachment = expectDefined(
      (result.activity.attachments as Array<{ content: { description: string } }>)[0],
      "default file-consent attachment",
    );
    expect(attachment.content.description).toBe("File: test.pdf");
  });

  it("uses provided description", () => {
    const result = prepare("Q4 Financial Report");

    const attachment = expectDefined(
      (result.activity.attachments as Array<{ content: { description: string } }>)[0],
      "described file-consent attachment",
    );
    expect(attachment.content.description).toBe("Q4 Financial Report");
  });

  it("includes uploadId in consent card context", () => {
    const result = prepare();

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
});
