import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as feishuBitable from "./src/bitable.js";
import * as feishuChannel from "./src/channel.js";
import * as feishuDocx from "./src/docx.js";
import * as feishuDrive from "./src/drive.js";
import * as feishuPerm from "./src/perm.js";
import * as feishuRuntime from "./src/runtime.js";
import * as feishuWiki from "./src/wiki.js";

const { registerFeishuBitableTools } = feishuBitable;
const { feishuPlugin } = feishuChannel;
const { registerFeishuDocTools } = feishuDocx;
const { registerFeishuDriveTools } = feishuDrive;
const { registerFeishuPermTools } = feishuPerm;
const { setFeishuRuntime } = feishuRuntime;
const { registerFeishuWikiTools } = feishuWiki;

export { monitorFeishuProvider } from "./src/monitor.js";
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
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    registerFeishuDocTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  },
};

export default plugin;
