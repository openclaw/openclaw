import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { twitchPlugin } from "./src/plugin.js";
import { setTwitchRuntime } from "./src/runtime.js";

export { monitorTwitchProvider } from "./src/monitor.js";

export default defineChannelPluginEntry({
	id: "twitch",
	name: "Twitch",
	description: "Twitch chat channel plugin",
	plugin: twitchPlugin,
	setRuntime: setTwitchRuntime,
});
