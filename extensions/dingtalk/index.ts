import type { OpenClawPluginApi } from "openclaw/plugin-sdk/dingtalk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/dingtalk";
import { dingtalkPlugin } from "./src/channel.js";
import { setDingtalkRuntime } from "./src/runtime.js";

export { monitorDingtalkProvider } from "./src/monitor.js";
export {
  sendTextMessage,
  sendMarkdownMessage,
  sendDingtalkDM,
  sendDingtalkGroup,
  sendMessageDingtalk,
} from "./src/send.js";
export { uploadMedia, downloadMessageFile, sendImageMessage } from "./src/media.js";
export { probeDingtalk } from "./src/probe.js";
export { sendDingtalkCard, updateDingtalkCard, DingtalkStreamingSession } from "./src/card.js";
export { dingtalkPlugin } from "./src/channel.js";

const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDingtalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
