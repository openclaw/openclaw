import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildFileConsentCard } from "./file-consent.js";
import { storePendingUploadFs } from "./pending-uploads-fs.js";
import { storePendingUpload } from "./pending-uploads.js";

export const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;

type FileConsentMedia = {
  buffer: Buffer;
  filename: string;
  contentType?: string;
};

type FileConsentActivityResult = {
  activity: Record<string, unknown>;
  uploadId: string;
};

function buildConsentActivity(params: {
  media: FileConsentMedia;
  description?: string;
  uploadId: string;
}): Record<string, unknown> {
  const { media, description, uploadId } = params;
  const consentCard = buildFileConsentCard({
    filename: media.filename,
    description: description || `File: ${media.filename}`,
    sizeInBytes: media.buffer.length,
    context: { uploadId },
  });
  return {
    type: "message",
    attachments: [consentCard],
  };
}

/** In-process replies keep consent bytes in memory; CLI sends use the persisted variant below. */
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

  return { activity: buildConsentActivity({ media, description, uploadId }), uploadId };
}

/** Persist consent bytes for callbacks received by another process after the CLI exits. */
export async function prepareFileConsentActivityFs(
  params: Parameters<typeof prepareFileConsentActivity>[0],
): Promise<FileConsentActivityResult> {
  const result = prepareFileConsentActivity(params);
  await storePendingUploadFs({
    id: result.uploadId,
    ...params.media,
    conversationId: params.conversationId,
  });
  return result;
}

export function requiresFileConsent(params: {
  conversationType: string | undefined;
  contentType: string | undefined;
  bufferSize: number;
}): boolean {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const isImage = params.contentType?.startsWith("image/") ?? false;
  const isLargeFile = params.bufferSize >= FILE_CONSENT_THRESHOLD_BYTES;
  return isPersonal && (isLargeFile || !isImage);
}
