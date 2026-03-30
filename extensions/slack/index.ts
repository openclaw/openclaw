import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { slackPlugin } from "./src/channel.js";
import { setSlackRuntime } from "./src/runtime.js";

export { slackPlugin } from "./src/channel.js";
export { setSlackRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
	id: "slack",
	name: "Slack",
	description: "Slack channel plugin",
	plugin: slackPlugin,
	setRuntime: setSlackRuntime,
});
