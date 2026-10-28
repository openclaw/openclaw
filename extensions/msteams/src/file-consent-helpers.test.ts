import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import * as pendingUploads from "./pending-uploads.js";

describe("requiresFileConsent", () => {
  const thresholdBytes = 4 * 1024 * 1024;

  it.each([
    ["personal", undefined, 1000, true],
    ["personal", "image/jpeg", thresholdBytes - 1, false],
  ] as const)(
    "%s chat with %s at %i bytes requires consent: %s",
    (conversationType, contentType, bufferSize, expected) => {
      expect(requiresFileConsent({ conversationType, contentType, bufferSize })).toBe(expected);
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

  it("uses default description when not provided", () => {
    const result = prepare();
    const attachment = expectDefined(
      (result.activity.attachments as Array<{ content: { description: string } }>)[0],
      "default file-consent attachment",
    );
    expect(attachment.content.description).toBe("File: test.pdf");
  });
});
