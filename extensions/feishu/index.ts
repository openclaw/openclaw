import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerFeishuSubagentHooks } from "./src/subagent-hooks.js";
import { registerFeishuWikiTools } from "./src/wiki.js";

let registeredRegistry: object | null = null;

export { feishuPlugin } from "./src/channel.js";
export { setFeishuRuntime } from "./src/runtime.js";
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

type MonitorFeishuProvider = typeof import("./src/monitor.js").monitorFeishuProvider;

let feishuMonitorPromise: Promise<typeof import("./src/monitor.js")> | null = null;

function loadFeishuMonitorModule() {
  feishuMonitorPromise ??= import("./src/monitor.js");
  return feishuMonitorPromise;
}

export async function monitorFeishuProvider(
  ...args: Parameters<MonitorFeishuProvider>
): ReturnType<MonitorFeishuProvider> {
  const { monitorFeishuProvider } = await loadFeishuMonitorModule();
  return await monitorFeishuProvider(...args);
}

export default defineChannelPluginEntry({
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  plugin: feishuPlugin,
  setRuntime: setFeishuRuntime,
  registerFull(api) {
    // Registry-bound guard: re-register when a new registry instance is
    // created (e.g. during in-process gateway restarts).
    if (registeredRegistry === api.registry) return;
    registeredRegistry = api.registry;
    registerFeishuSubagentHooks(api);
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  },
});
