import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { wechatLinuxSetupPlugin } from "./src/channel.setup.js";

export { wechatLinuxSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(wechatLinuxSetupPlugin);
