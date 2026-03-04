import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { createFeishuReplyDispatcher } from "./src/reply-dispatcher.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerFeishuWikiTools } from "./src/wiki.js";

export { monitorFeishuProvider } from "./src/monitor.js";
export { getBotOpenId } from "./src/monitor.js";
export { createFeishuReplyDispatcher } from "./src/reply-dispatcher.js";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu,
} from "./src/send.js";
export {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu,
} from "./src/media.js";
export { probeFeishu } from "./src/probe.js";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./src/reactions.js";
export {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
} from "./src/mention.js";
export { feishuPlugin } from "./src/channel.js";

const plugin = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Expose Feishu-native reply dispatcher factory for other plugins
    // (e.g. bot-company group dispatch) to reuse streaming card behavior.
    const replyRuntime =
      (api.runtime as unknown as { channel?: { reply?: Record<string, unknown> } })?.channel
        ?.reply ?? null;
    if (replyRuntime && typeof replyRuntime.createFeishuReplyDispatcher !== "function") {
      replyRuntime.createFeishuReplyDispatcher = createFeishuReplyDispatcher as unknown;
    }

    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  },
};

export default plugin;
