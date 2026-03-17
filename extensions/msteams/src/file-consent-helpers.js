import { buildFileConsentCard } from "./file-consent.js";
import { storePendingUpload } from "./pending-uploads.js";
function prepareFileConsentActivity(params) {
  const { media, conversationId, description } = params;
  const uploadId = storePendingUpload({
    buffer: media.buffer,
    filename: media.filename,
    contentType: media.contentType,
    conversationId
  });
  const consentCard = buildFileConsentCard({
    filename: media.filename,
    description: description || `File: ${media.filename}`,
    sizeInBytes: media.buffer.length,
    context: { uploadId }
  });
  const activity = {
    type: "message",
    attachments: [consentCard]
  };
  return { activity, uploadId };
}
function requiresFileConsent(params) {
  const isPersonal = params.conversationType?.toLowerCase() === "personal";
  const isImage = params.contentType?.startsWith("image/") ?? false;
  const isLargeFile = params.bufferSize >= params.thresholdBytes;
  return isPersonal && (isLargeFile || !isImage);
}
export {
  prepareFileConsentActivity,
  requiresFileConsent
};
