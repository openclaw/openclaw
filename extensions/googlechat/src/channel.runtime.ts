import { probeGoogleChat, sendGoogleChatMessage } from "./api.js";
import { resolveGoogleChatWebhookPath, startGoogleChatMonitor } from "./monitor.js";

export const googleChatChannelRuntime = {
  probeGoogleChat,
  sendGoogleChatMessage,
  resolveGoogleChatWebhookPath,
  startGoogleChatMonitor,
};
