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

export { feishuPlugin } from "./src/channel.js";
export {
	sendFileFeishu,
	sendImageFeishu,
	sendMediaFeishu,
	uploadFileFeishu,
	uploadImageFeishu,
} from "./src/media.js";
export {
	buildMentionedCardContent,
	buildMentionedMessage,
	extractMentionTargets,
	extractMessageBody,
	formatMentionAllForCard,
	formatMentionAllForText,
	formatMentionForCard,
	formatMentionForText,
	isMentionForwardRequest,
	type MentionTarget,
} from "./src/mention.js";
export { probeFeishu } from "./src/probe.js";
export {
	addReactionFeishu,
	FeishuEmoji,
	listReactionsFeishu,
	removeReactionFeishu,
} from "./src/reactions.js";
export { setFeishuRuntime } from "./src/runtime.js";
export {
	editMessageFeishu,
	getMessageFeishu,
	sendCardFeishu,
	sendMessageFeishu,
	updateCardFeishu,
} from "./src/send.js";

type MonitorFeishuProvider =
	typeof import("./src/monitor.js").monitorFeishuProvider;

let feishuMonitorPromise: Promise<typeof import("./src/monitor.js")> | null =
	null;

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
		registerFeishuSubagentHooks(api);
		registerFeishuDocTools(api);
		registerFeishuChatTools(api);
		registerFeishuWikiTools(api);
		registerFeishuDriveTools(api);
		registerFeishuPermTools(api);
		registerFeishuBitableTools(api);
	},
});
