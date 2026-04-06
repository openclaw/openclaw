import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { registerFeishuWikiTools } from "./src/wiki.js";

export { feishuPlugin } from "./src/channel.js";
export { setFeishuRuntime } from "./src/runtime.js";
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

type MonitorFeishuProvider = typeof import("./src/monitor.js").monitorFeishuProvider;
type FeishuSubagentHooksModule = typeof import("./src/subagent-hooks.js");

let feishuMonitorPromise: Promise<typeof import("./src/monitor.js")> | null = null;
let feishuSubagentHooksPromise: Promise<FeishuSubagentHooksModule> | null = null;

function loadFeishuMonitorModule() {
  feishuMonitorPromise ??= import("./src/monitor.js");
  return feishuMonitorPromise;
}

function loadFeishuSubagentHooksModule() {
  feishuSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return feishuSubagentHooksPromise;
}

export async function monitorFeishuProvider(
  ...args: Parameters<MonitorFeishuProvider>
): ReturnType<MonitorFeishuProvider> {
  const { monitorFeishuProvider } = await loadFeishuMonitorModule();
  return await monitorFeishuProvider(...args);
}

export default defineBundledChannelEntry({
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "feishuPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setFeishuRuntime",
  },
  registerFull(api) {
    // Expose the native feishu reply dispatcher on the runtime so external
    // plugins (e.g. bot-company) can create streaming-card capable dispatchers
    // instead of falling back to the generic route-reply path.
    (async () => {
      const { createFeishuReplyDispatcher } = await import("./src/reply-dispatcher.js");
      const replyRuntime = (api.runtime as { channel?: { reply?: Record<string, unknown> } })
        ?.channel?.reply;
      if (replyRuntime && typeof replyRuntime.createFeishuReplyDispatcher !== "function") {
        replyRuntime.createFeishuReplyDispatcher = createFeishuReplyDispatcher;
      }
    })();

    api.on("subagent_spawning", async (event, ctx) => {
      const { handleFeishuSubagentSpawning } = await loadFeishuSubagentHooksModule();
      return await handleFeishuSubagentSpawning(event, ctx);
    });
    api.on("subagent_delivery_target", async (event) => {
      const { handleFeishuSubagentDeliveryTarget } = await loadFeishuSubagentHooksModule();
      return await handleFeishuSubagentDeliveryTarget(event);
    });
    api.on("subagent_ended", async (event) => {
      const { handleFeishuSubagentEnded } = await loadFeishuSubagentHooksModule();
      await handleFeishuSubagentEnded(event);
    });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  },
});
