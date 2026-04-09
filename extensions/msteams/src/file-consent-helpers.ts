/**
 * Shared helpers for FileConsentCard flow in MSTeams.
 *
 * FileConsentCard is required for:
 * - Personal (1:1) chats with large files (>=4MB)
 * - Personal chats with non-image files (PDFs, documents, etc.)
 *
 * This module consolidates the logic used by both send.ts (proactive sends)
 * and messenger.ts (reply path) to avoid duplication.
 */

import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { buildFileConsentCard } from "./file-consent.js";
import { getDefaultPendingUploadFsStore, type PendingUploadFsStore } from "./pending-uploads-fs.js";
import { storePendingUpload } from "./pending-uploads.js";

export type FileConsentMedia = {
  buffer: Buffer;
  filename: string;
  contentType?: string;
};

export type FileConsentActivityResult = {
  activity: Record<string, unknown>;
  uploadId: string;
};

function buildConsentActivity(params: {
  filename: string;
  sizeInBytes: number;
  description?: string;
  uploadId: string;
}): Record<string, unknown> {
  const consentCard = buildFileConsentCard({
    filename: params.filename,
    description: params.description || `File: ${params.filename}`,
    sizeInBytes: params.sizeInBytes,
    context: { uploadId: params.uploadId },
  });
  return {
    type: "message",
    attachments: [consentCard],
  };
}

/**
 * Prepare a FileConsentCard activity for large files or non-images in personal chats.
 * Stores the pending upload in the in-process memory store so the in-process
 * webhook handler can honor the consent callback. Use
 * `prepareFileConsentActivityFs` for cross-process sends (e.g. the CLI
 * `message send --media` path) where the invoke webhook lands in a different
 * process than the sender.
 */
export function prepareFileConsentActivity(params: {
  media: FileConsentMedia;
  conversationId: string;
  description?: string;
}): FileConsentActivityResult {
  const { media, conversationId, description } = params;

  const uploadId = storePendingUpload({
    buffer: media.buffer,
    filename: media.filename,
    contentType: media.contentType,
    conversationId,
  });

  const activity = buildConsentActivity({
    filename: media.filename,
    sizeInBytes: media.buffer.length,
    description,
    uploadId,
  });

  return { activity, uploadId };
}

/**
 * Cross-process variant of `prepareFileConsentActivity` backed by the
 * filesystem store.
 *
 * The `openclaw message send --media` CLI sends the consent card from a
 * short-lived process, but the `fileConsent/invoke` callback lands on the
 * long-running monitor webhook — a different process. The in-memory
 * pending-upload Map used by `prepareFileConsentActivity` is invisible across
 * processes, so the accept handler has nothing to upload.
 *
 * This helper persists the file bytes to the msteams state directory so any
 * process with access to the state dir can honor the consent callback.
 */
export async function prepareFileConsentActivityFs(params: {
  media: FileConsentMedia;
  conversationId: string;
  description?: string;
  /** Override for tests — defaults to the shared on-disk store. */
  store?: PendingUploadFsStore;
}): Promise<FileConsentActivityResult> {
  const { media, conversationId, description } = params;
  const store = params.store ?? getDefaultPendingUploadFsStore();

  const uploadId = await store.store({
    buffer: media.buffer,
    filename: media.filename,
    contentType: media.contentType,
    conversationId,
  });

  const activity = buildConsentActivity({
    filename: media.filename,
    sizeInBytes: media.buffer.length,
    description,
    uploadId,
  });

  return { activity, uploadId };
}

/**
 * Check if a file requires FileConsentCard flow.
 * True for: personal chat AND (large file OR non-image)
 */
export function requiresFileConsent(params: {
  conversationType: string | undefined;
  contentType: string | undefined;
  bufferSize: number;
  thresholdBytes: number;
}): boolean {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const isImage = params.contentType?.startsWith("image/") ?? false;
  const isLargeFile = params.bufferSize >= params.thresholdBytes;
  return isPersonal && (isLargeFile || !isImage);
}
