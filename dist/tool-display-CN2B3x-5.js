import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as redactToolDetail } from "./redact-ok5Q8nmw.js";
import { h as shortenHomeInString } from "./utils-sBTEdeml.js";
import { i as normalizeToolName, n as formatDetailKey, o as resolveToolVerbAndDetailForArgs, r as formatToolDetailText, t as defaultTitle } from "./tool-display-common-D5L_bf7a.js";
//#region src/agents/tool-display-config.ts
const TOOL_DISPLAY_CONFIG = {
	version: 1,
	fallback: {
		emoji: "🧩",
		detailKeys: [
			"command",
			"path",
			"url",
			"targetUrl",
			"targetId",
			"ref",
			"element",
			"node",
			"nodeId",
			"id",
			"requestId",
			"to",
			"channelId",
			"guildId",
			"userId",
			"name",
			"query",
			"pattern",
			"messageId"
		]
	},
	tools: {
		bash: {
			emoji: "🛠️",
			title: "Bash",
			detailKeys: ["command"]
		},
		process: {
			emoji: "🧰",
			title: "Process",
			detailKeys: ["sessionId"]
		},
		read: {
			emoji: "📖",
			title: "Read",
			detailKeys: ["path"]
		},
		write: {
			emoji: "✍️",
			title: "Write",
			detailKeys: ["path"]
		},
		edit: {
			emoji: "📝",
			title: "Edit",
			detailKeys: ["path"]
		},
		attach: {
			emoji: "📎",
			title: "Attach",
			detailKeys: [
				"path",
				"url",
				"fileName"
			]
		},
		browser: {
			emoji: "🌐",
			title: "Browser",
			actions: {
				status: { label: "status" },
				start: { label: "start" },
				stop: { label: "stop" },
				tabs: { label: "tabs" },
				open: {
					label: "open",
					detailKeys: ["targetUrl"]
				},
				focus: {
					label: "focus",
					detailKeys: ["targetId"]
				},
				close: {
					label: "close",
					detailKeys: ["targetId"]
				},
				snapshot: {
					label: "snapshot",
					detailKeys: [
						"targetUrl",
						"targetId",
						"ref",
						"element",
						"format"
					]
				},
				screenshot: {
					label: "screenshot",
					detailKeys: [
						"targetUrl",
						"targetId",
						"ref",
						"element"
					]
				},
				navigate: {
					label: "navigate",
					detailKeys: ["targetUrl", "targetId"]
				},
				console: {
					label: "console",
					detailKeys: ["level", "targetId"]
				},
				pdf: {
					label: "pdf",
					detailKeys: ["targetId"]
				},
				upload: {
					label: "upload",
					detailKeys: [
						"paths",
						"ref",
						"inputRef",
						"element",
						"targetId"
					]
				},
				dialog: {
					label: "dialog",
					detailKeys: [
						"accept",
						"promptText",
						"targetId"
					]
				},
				act: {
					label: "act",
					detailKeys: [
						"request.kind",
						"request.ref",
						"request.selector",
						"request.text",
						"request.value"
					]
				}
			}
		},
		canvas: {
			emoji: "🖼️",
			title: "Canvas",
			actions: {
				present: {
					label: "present",
					detailKeys: [
						"target",
						"node",
						"nodeId"
					]
				},
				hide: {
					label: "hide",
					detailKeys: ["node", "nodeId"]
				},
				navigate: {
					label: "navigate",
					detailKeys: [
						"url",
						"node",
						"nodeId"
					]
				},
				eval: {
					label: "eval",
					detailKeys: [
						"javaScript",
						"node",
						"nodeId"
					]
				},
				snapshot: {
					label: "snapshot",
					detailKeys: [
						"format",
						"node",
						"nodeId"
					]
				},
				a2ui_push: {
					label: "A2UI push",
					detailKeys: [
						"jsonlPath",
						"node",
						"nodeId"
					]
				},
				a2ui_reset: {
					label: "A2UI reset",
					detailKeys: ["node", "nodeId"]
				}
			}
		},
		nodes: {
			emoji: "📱",
			title: "Nodes",
			actions: {
				status: { label: "status" },
				describe: {
					label: "describe",
					detailKeys: ["node", "nodeId"]
				},
				pending: { label: "pending" },
				approve: {
					label: "approve",
					detailKeys: ["requestId"]
				},
				reject: {
					label: "reject",
					detailKeys: ["requestId"]
				},
				notify: {
					label: "notify",
					detailKeys: [
						"node",
						"nodeId",
						"title",
						"body"
					]
				},
				camera_snap: {
					label: "camera snap",
					detailKeys: [
						"node",
						"nodeId",
						"facing",
						"deviceId"
					]
				},
				camera_list: {
					label: "camera list",
					detailKeys: ["node", "nodeId"]
				},
				camera_clip: {
					label: "camera clip",
					detailKeys: [
						"node",
						"nodeId",
						"facing",
						"duration",
						"durationMs"
					]
				},
				screen_record: {
					label: "screen record",
					detailKeys: [
						"node",
						"nodeId",
						"duration",
						"durationMs",
						"fps",
						"screenIndex"
					]
				}
			}
		},
		cron: {
			emoji: "⏰",
			title: "Cron",
			actions: {
				status: { label: "status" },
				list: { label: "list" },
				add: {
					label: "add",
					detailKeys: [
						"job.name",
						"job.id",
						"job.schedule",
						"job.cron"
					]
				},
				update: {
					label: "update",
					detailKeys: ["id"]
				},
				remove: {
					label: "remove",
					detailKeys: ["id"]
				},
				run: {
					label: "run",
					detailKeys: ["id"]
				},
				runs: {
					label: "runs",
					detailKeys: ["id"]
				},
				wake: {
					label: "wake",
					detailKeys: ["text", "mode"]
				}
			}
		},
		update_plan: {
			emoji: "🗺️",
			title: "Update Plan",
			detailKeys: ["explanation", "plan.0.step"]
		},
		gateway: {
			emoji: "🔌",
			title: "Gateway",
			actions: { restart: {
				label: "restart",
				detailKeys: ["reason", "delayMs"]
			} }
		},
		exec: {
			emoji: "🛠️",
			title: "Exec",
			detailKeys: ["command"]
		},
		tool_call: {
			emoji: "🧰",
			title: "Tool Call",
			detailKeys: []
		},
		tool_call_update: {
			emoji: "🧰",
			title: "Tool Call",
			detailKeys: []
		},
		session_status: {
			emoji: "📊",
			title: "Session Status",
			detailKeys: ["sessionKey", "model"]
		},
		sessions_list: {
			emoji: "🗂️",
			title: "Sessions",
			detailKeys: [
				"kinds",
				"label",
				"agentId",
				"search",
				"limit",
				"activeMinutes",
				"includeDerivedTitles",
				"includeLastMessage",
				"messageLimit"
			]
		},
		sessions_send: {
			emoji: "📨",
			title: "Session Send",
			detailKeys: [
				"label",
				"sessionKey",
				"agentId",
				"timeoutSeconds"
			]
		},
		sessions_history: {
			emoji: "🧾",
			title: "Session History",
			detailKeys: [
				"sessionKey",
				"limit",
				"includeTools"
			]
		},
		sessions_spawn: {
			emoji: "🧑‍🔧",
			title: "Sub-agent",
			detailKeys: [
				"label",
				"task",
				"agentId",
				"model",
				"thinking",
				"runTimeoutSeconds",
				"cleanup"
			]
		},
		subagents: {
			emoji: "🤖",
			title: "Subagents",
			actions: {
				list: {
					label: "list",
					detailKeys: ["recentMinutes"]
				},
				kill: {
					label: "kill",
					detailKeys: ["target"]
				},
				steer: {
					label: "steer",
					detailKeys: ["target"]
				}
			}
		},
		agents_list: {
			emoji: "🧭",
			title: "Agents",
			detailKeys: []
		},
		memory_search: {
			emoji: "🧠",
			title: "Memory Search",
			detailKeys: ["query"]
		},
		memory_get: {
			emoji: "📓",
			title: "Memory Get",
			detailKeys: [
				"path",
				"from",
				"lines"
			]
		},
		web_search: {
			emoji: "🔎",
			title: "Web Search",
			detailKeys: ["query", "count"]
		},
		web_fetch: {
			emoji: "📄",
			title: "Web Fetch",
			detailKeys: [
				"url",
				"extractMode",
				"maxChars"
			]
		},
		code_execution: {
			emoji: "🧮",
			title: "Code Execution",
			detailKeys: ["task"]
		},
		message: {
			emoji: "✉️",
			title: "Message",
			actions: {
				send: {
					label: "send",
					detailKeys: [
						"provider",
						"to",
						"media",
						"replyTo",
						"threadId"
					]
				},
				poll: {
					label: "poll",
					detailKeys: [
						"provider",
						"to",
						"pollQuestion"
					]
				},
				react: {
					label: "react",
					detailKeys: [
						"provider",
						"to",
						"messageId",
						"emoji",
						"remove"
					]
				},
				reactions: {
					label: "reactions",
					detailKeys: [
						"provider",
						"to",
						"messageId",
						"limit"
					]
				},
				read: {
					label: "read",
					detailKeys: [
						"provider",
						"to",
						"limit"
					]
				},
				edit: {
					label: "edit",
					detailKeys: [
						"provider",
						"to",
						"messageId"
					]
				},
				delete: {
					label: "delete",
					detailKeys: [
						"provider",
						"to",
						"messageId"
					]
				},
				pin: {
					label: "pin",
					detailKeys: [
						"provider",
						"to",
						"messageId"
					]
				},
				unpin: {
					label: "unpin",
					detailKeys: [
						"provider",
						"to",
						"messageId"
					]
				},
				"list-pins": {
					label: "list pins",
					detailKeys: ["provider", "to"]
				},
				permissions: {
					label: "permissions",
					detailKeys: [
						"provider",
						"channelId",
						"to"
					]
				},
				"thread-create": {
					label: "thread create",
					detailKeys: [
						"provider",
						"channelId",
						"threadName"
					]
				},
				"thread-list": {
					label: "thread list",
					detailKeys: [
						"provider",
						"guildId",
						"channelId"
					]
				},
				"thread-reply": {
					label: "thread reply",
					detailKeys: [
						"provider",
						"channelId",
						"messageId"
					]
				},
				search: {
					label: "search",
					detailKeys: [
						"provider",
						"guildId",
						"query"
					]
				},
				sticker: {
					label: "sticker",
					detailKeys: [
						"provider",
						"to",
						"stickerId"
					]
				},
				"member-info": {
					label: "member",
					detailKeys: [
						"provider",
						"guildId",
						"userId"
					]
				},
				"role-info": {
					label: "roles",
					detailKeys: ["provider", "guildId"]
				},
				"emoji-list": {
					label: "emoji list",
					detailKeys: ["provider", "guildId"]
				},
				"emoji-upload": {
					label: "emoji upload",
					detailKeys: [
						"provider",
						"guildId",
						"emojiName"
					]
				},
				"sticker-upload": {
					label: "sticker upload",
					detailKeys: [
						"provider",
						"guildId",
						"stickerName"
					]
				},
				"role-add": {
					label: "role add",
					detailKeys: [
						"provider",
						"guildId",
						"userId",
						"roleId"
					]
				},
				"role-remove": {
					label: "role remove",
					detailKeys: [
						"provider",
						"guildId",
						"userId",
						"roleId"
					]
				},
				"channel-info": {
					label: "channel",
					detailKeys: ["provider", "channelId"]
				},
				"channel-list": {
					label: "channels",
					detailKeys: ["provider", "guildId"]
				},
				"voice-status": {
					label: "voice",
					detailKeys: [
						"provider",
						"guildId",
						"userId"
					]
				},
				"event-list": {
					label: "events",
					detailKeys: ["provider", "guildId"]
				},
				"event-create": {
					label: "event create",
					detailKeys: [
						"provider",
						"guildId",
						"eventName"
					]
				},
				timeout: {
					label: "timeout",
					detailKeys: [
						"provider",
						"guildId",
						"userId"
					]
				},
				kick: {
					label: "kick",
					detailKeys: [
						"provider",
						"guildId",
						"userId"
					]
				},
				ban: {
					label: "ban",
					detailKeys: [
						"provider",
						"guildId",
						"userId"
					]
				}
			}
		},
		apply_patch: {
			emoji: "🩹",
			title: "Apply Patch",
			detailKeys: []
		},
		image: {
			emoji: "🖼️",
			title: "Image",
			detailKeys: [
				"path",
				"paths",
				"url",
				"urls",
				"prompt",
				"model"
			]
		},
		image_generate: {
			emoji: "🎨",
			title: "Image Generation",
			actions: {
				generate: {
					label: "generate",
					detailKeys: [
						"prompt",
						"model",
						"count",
						"resolution",
						"aspectRatio"
					]
				},
				list: {
					label: "list",
					detailKeys: ["provider", "model"]
				}
			}
		},
		music_generate: {
			emoji: "🎵",
			title: "Music Generation",
			actions: {
				generate: {
					label: "generate",
					detailKeys: [
						"prompt",
						"model",
						"durationSeconds",
						"format",
						"instrumental"
					]
				},
				list: {
					label: "list",
					detailKeys: ["provider", "model"]
				}
			}
		},
		video_generate: {
			emoji: "🎬",
			title: "Video Generation",
			actions: {
				generate: {
					label: "generate",
					detailKeys: [
						"prompt",
						"model",
						"durationSeconds",
						"resolution",
						"aspectRatio",
						"audio",
						"watermark"
					]
				},
				list: {
					label: "list",
					detailKeys: ["provider", "model"]
				}
			}
		},
		pdf: {
			emoji: "📑",
			title: "PDF",
			detailKeys: [
				"path",
				"paths",
				"url",
				"urls",
				"prompt",
				"pageRange",
				"model"
			]
		},
		sessions_yield: {
			emoji: "⏸️",
			title: "Yield",
			detailKeys: ["message"]
		},
		tts: {
			emoji: "🔊",
			title: "TTS",
			detailKeys: ["text", "channel"]
		}
	}
};
//#endregion
//#region src/agents/tool-display.ts
const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};
const DETAIL_LABEL_OVERRIDES = {
	agentId: "agent",
	sessionKey: "session",
	targetId: "target",
	targetUrl: "url",
	nodeId: "node",
	requestId: "request",
	messageId: "message",
	threadId: "thread",
	channelId: "channel",
	guildId: "guild",
	userId: "user",
	runTimeoutSeconds: "timeout",
	timeoutSeconds: "timeout",
	includeTools: "tools",
	pollQuestion: "poll",
	maxChars: "max chars"
};
const MAX_DETAIL_ENTRIES = 8;
function resolveToolDisplay(params) {
	const name = normalizeToolName(params.name);
	const key = normalizeLowercaseStringOrEmpty(name);
	const spec = TOOL_MAP[key];
	const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
	const title = spec?.title ?? defaultTitle(name);
	const label = spec?.label ?? title;
	let { verb, detail } = resolveToolVerbAndDetailForArgs({
		toolKey: key,
		args: params.args,
		meta: params.meta,
		spec,
		fallbackDetailKeys: FALLBACK.detailKeys,
		detailMode: "summary",
		toolDetailMode: params.detailMode,
		detailMaxEntries: MAX_DETAIL_ENTRIES,
		detailFormatKey: (raw) => formatDetailKey(raw, DETAIL_LABEL_OVERRIDES)
	});
	if (detail) detail = shortenHomeInString(detail);
	return {
		name,
		emoji,
		title,
		label,
		verb,
		detail
	};
}
function formatToolDetail(display) {
	return formatToolDetailText(display.detail ? redactToolDetail(display.detail) : void 0);
}
function formatToolSummary(display) {
	const detail = formatToolDetail(display);
	if (detail && (display.name === "bash" || display.name === "exec")) return `${display.emoji} ${detail}`;
	return detail ? `${display.emoji} ${display.label}: ${detail}` : `${display.emoji} ${display.label}`;
}
//#endregion
export { TOOL_DISPLAY_CONFIG as i, formatToolSummary as n, resolveToolDisplay as r, formatToolDetail as t };
