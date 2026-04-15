import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export { monitorDingtalkProvider } from "./src/monitor.js";
export {
  sendTextMessage,
  sendMarkdownMessage,
  sendDingtalkDM,
  sendDingtalkGroup,
  sendMessageDingtalk,
} from "./src/send.js";
export { uploadMedia, downloadMessageFile, sendImageMessage } from "./src/media.js";
export { createAICard, streamAICard, finishAICard } from "./src/card.js";
export { probeDingtalk } from "./src/probe.js";
export { dingtalkPlugin } from "./src/channel.js";

export default defineBundledChannelEntry({
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "dingtalkPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setDingtalkRuntime",
  },
});
