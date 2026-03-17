import {
  probeGoogleChat as probeGoogleChatImpl,
  sendGoogleChatMessage as sendGoogleChatMessageImpl,
  uploadGoogleChatAttachment as uploadGoogleChatAttachmentImpl,
} from "./api.js";
import {
  resolveGoogleChatWebhookPath as resolveGoogleChatWebhookPathImpl,
  startGoogleChatMonitor as startGoogleChatMonitorImpl,
} from "./monitor.js";

type ProbeGoogleChat = typeof import("./api.js").probeGoogleChat;
type SendGoogleChatMessage = typeof import("./api.js").sendGoogleChatMessage;
type UploadGoogleChatAttachment = typeof import("./api.js").uploadGoogleChatAttachment;
type ResolveGoogleChatWebhookPath = typeof import("./monitor.js").resolveGoogleChatWebhookPath;
type StartGoogleChatMonitor = typeof import("./monitor.js").startGoogleChatMonitor;

export function probeGoogleChat(...args: Parameters<ProbeGoogleChat>): ReturnType<ProbeGoogleChat> {
  return probeGoogleChatImpl(...args);
}

export function sendGoogleChatMessage(
  ...args: Parameters<SendGoogleChatMessage>
): ReturnType<SendGoogleChatMessage> {
  return sendGoogleChatMessageImpl(...args);
}

export function uploadGoogleChatAttachment(
  ...args: Parameters<UploadGoogleChatAttachment>
): ReturnType<UploadGoogleChatAttachment> {
  return uploadGoogleChatAttachmentImpl(...args);
}

export function resolveGoogleChatWebhookPath(
  ...args: Parameters<ResolveGoogleChatWebhookPath>
): ReturnType<ResolveGoogleChatWebhookPath> {
  return resolveGoogleChatWebhookPathImpl(...args);
}

export function startGoogleChatMonitor(
  ...args: Parameters<StartGoogleChatMonitor>
): ReturnType<StartGoogleChatMonitor> {
  return startGoogleChatMonitorImpl(...args);
}
