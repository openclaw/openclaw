// Googlechat plugin module implements channel behavior.
import {
  isGoogleChatAttachmentUploadUnauthorized as isGoogleChatAttachmentUploadUnauthorizedImpl,
  probeGoogleChat as probeGoogleChatImpl,
  sendGoogleChatMessage as sendGoogleChatMessageImpl,
  uploadGoogleChatAttachment as uploadGoogleChatAttachmentImpl,
} from "./api.js";
import {
  resolveGoogleChatWebhookPath as resolveGoogleChatWebhookPathImpl,
  startGoogleChatMonitor as startGoogleChatMonitorImpl,
} from "./monitor.js";

export const googleChatChannelRuntime = {
  isGoogleChatAttachmentUploadUnauthorized: isGoogleChatAttachmentUploadUnauthorizedImpl,
  probeGoogleChat: probeGoogleChatImpl,
  sendGoogleChatMessage: sendGoogleChatMessageImpl,
  uploadGoogleChatAttachment: uploadGoogleChatAttachmentImpl,
  resolveGoogleChatWebhookPath: resolveGoogleChatWebhookPathImpl,
  startGoogleChatMonitor: startGoogleChatMonitorImpl,
};
