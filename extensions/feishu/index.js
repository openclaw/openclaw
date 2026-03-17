import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/feishu";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerFeishuWikiTools } from "./src/wiki.js";
import { monitorFeishuProvider } from "./src/monitor.js";
import {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu
} from "./src/send.js";
import {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu
} from "./src/media.js";
import { probeFeishu } from "./src/probe.js";
import {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji
} from "./src/reactions.js";
import {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent
} from "./src/mention.js";
import { feishuPlugin as feishuPlugin2 } from "./src/channel.js";
const plugin = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  }
};
var feishu_default = plugin;
export {
  FeishuEmoji,
  addReactionFeishu,
  buildMentionedCardContent,
  buildMentionedMessage,
  feishu_default as default,
  editMessageFeishu,
  extractMentionTargets,
  extractMessageBody,
  feishuPlugin2 as feishuPlugin,
  formatMentionAllForCard,
  formatMentionAllForText,
  formatMentionForCard,
  formatMentionForText,
  getMessageFeishu,
  isMentionForwardRequest,
  listReactionsFeishu,
  monitorFeishuProvider,
  probeFeishu,
  removeReactionFeishu,
  sendCardFeishu,
  sendFileFeishu,
  sendImageFeishu,
  sendMediaFeishu,
  sendMessageFeishu,
  updateCardFeishu,
  uploadFileFeishu,
  uploadImageFeishu
};
