import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { telegramSetupPlugin } from "./src/channel.setup.js";

export { telegramSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(telegramSetupPlugin);
