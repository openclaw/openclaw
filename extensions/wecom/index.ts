import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wecomPlugin } from "./src/channel.js";
import { setWeComRuntime } from "./src/runtime.js";

export { sendMessageWeCom, sendGroupMessageWeCom } from "./src/send.js";
export { probeWeCom } from "./src/probe.js";
export { monitorWeComProvider } from "./src/monitor.js";
export { downloadImageWeCom } from "./src/media.js";
export {
  getUserInfoWeCom,
  getDepartmentListWeCom,
  getDepartmentUsersWeCom,
} from "./src/directory.js";
export { wecomPlugin } from "./src/channel.js";

const plugin = {
  id: "wecom",
  name: "WeCom",
  description: "WeCom (企业微信) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWeComRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });
  },
};

export default plugin;
