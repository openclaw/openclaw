import { r as loadBundledEntryExportSync, t as defineBundledChannelEntry } from "../../channel-entry-contract-CSjRAxu4.js";
import { t as registerFeishuSubagentHooks } from "../../subagent-hooks-api-CRPb0d4r.js";
//#region extensions/feishu/index.ts
function registerFeishuDocTools(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "registerFeishuDocTools"
	})(api);
}
function registerFeishuChatTools(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "registerFeishuChatTools"
	})(api);
}
function registerFeishuWikiTools(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "registerFeishuWikiTools"
	})(api);
}
function registerFeishuDriveTools(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "registerFeishuDriveTools"
	})(api);
}
function registerFeishuPermTools(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "registerFeishuPermTools"
	})(api);
}
function registerFeishuBitableTools(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "registerFeishuBitableTools"
	})(api);
}
var feishu_default = defineBundledChannelEntry({
	id: "feishu",
	name: "Feishu",
	description: "Feishu/Lark channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "feishuPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setFeishuRuntime"
	},
	registerFull(api) {
		registerFeishuSubagentHooks(api);
		registerFeishuDocTools(api);
		registerFeishuChatTools(api);
		registerFeishuWikiTools(api);
		registerFeishuDriveTools(api);
		registerFeishuPermTools(api);
		registerFeishuBitableTools(api);
	}
});
//#endregion
export { feishu_default as default };
