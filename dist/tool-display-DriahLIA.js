import { b as shortenHomeInString } from "./utils-xLjEf_5u.js";
import { r as redactToolDetail } from "./redact-LEFt15z2.js";

//#region apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
var tool_display_default = {
	version: 1,
	fallback: {
		"emoji": "🧩",
		"detailKeys": [
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
		"bash": {
			"emoji": "🛠️",
			"title": "Bash",
			"detailKeys": ["command"]
		},
		"process": {
			"emoji": "🧰",
			"title": "Process",
			"detailKeys": ["sessionId"]
		},
		"read": {
			"emoji": "📖",
			"title": "Read",
			"detailKeys": ["path"]
		},
		"write": {
			"emoji": "✍️",
			"title": "Write",
			"detailKeys": ["path"]
		},
		"edit": {
			"emoji": "📝",
			"title": "Edit",
			"detailKeys": ["path"]
		},
		"attach": {
			"emoji": "📎",
			"title": "Attach",
			"detailKeys": [
				"path",
				"url",
				"fileName"
			]
		},
		"browser": {
			"emoji": "🌐",
			"title": "Browser",
			"actions": {
				"status": { "label": "status" },
				"start": { "label": "start" },
				"stop": { "label": "stop" },
				"tabs": { "label": "tabs" },
				"open": {
					"label": "open",
					"detailKeys": ["targetUrl"]
				},
				"focus": {
					"label": "focus",
					"detailKeys": ["targetId"]
				},
				"close": {
					"label": "close",
					"detailKeys": ["targetId"]
				},
				"snapshot": {
					"label": "snapshot",
					"detailKeys": [
						"targetUrl",
						"targetId",
						"ref",
						"element",
						"format"
					]
				},
				"screenshot": {
					"label": "screenshot",
					"detailKeys": [
						"targetUrl",
						"targetId",
						"ref",
						"element"
					]
				},
				"navigate": {
					"label": "navigate",
					"detailKeys": ["targetUrl", "targetId"]
				},
				"console": {
					"label": "console",
					"detailKeys": ["level", "targetId"]
				},
				"pdf": {
					"label": "pdf",
					"detailKeys": ["targetId"]
				},
				"upload": {
					"label": "upload",
					"detailKeys": [
						"paths",
						"ref",
						"inputRef",
						"element",
						"targetId"
					]
				},
				"dialog": {
					"label": "dialog",
					"detailKeys": [
						"accept",
						"promptText",
						"targetId"
					]
				},
				"act": {
					"label": "act",
					"detailKeys": [
						"request.kind",
						"request.ref",
						"request.selector",
						"request.text",
						"request.value"
					]
				}
			}
		},
		"canvas": {
			"emoji": "🖼️",
			"title": "Canvas",
			"actions": {
				"present": {
					"label": "present",
					"detailKeys": [
						"target",
						"node",
						"nodeId"
					]
				},
				"hide": {
					"label": "hide",
					"detailKeys": ["node", "nodeId"]
				},
				"navigate": {
					"label": "navigate",
					"detailKeys": [
						"url",
						"node",
						"nodeId"
					]
				},
				"eval": {
					"label": "eval",
					"detailKeys": [
						"javaScript",
						"node",
						"nodeId"
					]
				},
				"snapshot": {
					"label": "snapshot",
					"detailKeys": [
						"format",
						"node",
						"nodeId"
					]
				},
				"a2ui_push": {
					"label": "A2UI push",
					"detailKeys": [
						"jsonlPath",
						"node",
						"nodeId"
					]
				},
				"a2ui_reset": {
					"label": "A2UI reset",
					"detailKeys": ["node", "nodeId"]
				}
			}
		},
		"nodes": {
			"emoji": "📱",
			"title": "Nodes",
			"actions": {
				"status": { "label": "status" },
				"describe": {
					"label": "describe",
					"detailKeys": ["node", "nodeId"]
				},
				"pending": { "label": "pending" },
				"approve": {
					"label": "approve",
					"detailKeys": ["requestId"]
				},
				"reject": {
					"label": "reject",
					"detailKeys": ["requestId"]
				},
				"notify": {
					"label": "notify",
					"detailKeys": [
						"node",
						"nodeId",
						"title",
						"body"
					]
				},
				"camera_snap": {
					"label": "camera snap",
					"detailKeys": [
						"node",
						"nodeId",
						"facing",
						"deviceId"
					]
				},
				"camera_list": {
					"label": "camera list",
					"detailKeys": ["node", "nodeId"]
				},
				"camera_clip": {
					"label": "camera clip",
					"detailKeys": [
						"node",
						"nodeId",
						"facing",
						"duration",
						"durationMs"
					]
				},
				"screen_record": {
					"label": "screen record",
					"detailKeys": [
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
		"cron": {
			"emoji": "⏰",
			"title": "Cron",
			"actions": {
				"status": { "label": "status" },
				"list": { "label": "list" },
				"add": {
					"label": "add",
					"detailKeys": [
						"job.name",
						"job.id",
						"job.schedule",
						"job.cron"
					]
				},
				"update": {
					"label": "update",
					"detailKeys": ["id"]
				},
				"remove": {
					"label": "remove",
					"detailKeys": ["id"]
				},
				"run": {
					"label": "run",
					"detailKeys": ["id"]
				},
				"runs": {
					"label": "runs",
					"detailKeys": ["id"]
				},
				"wake": {
					"label": "wake",
					"detailKeys": ["text", "mode"]
				}
			}
		},
		"gateway": {
			"emoji": "🔌",
			"title": "Gateway",
			"actions": { "restart": {
				"label": "restart",
				"detailKeys": ["reason", "delayMs"]
			} }
		},
		"whatsapp_login": {
			"emoji": "🟢",
			"title": "WhatsApp Login",
			"actions": {
				"start": { "label": "start" },
				"wait": { "label": "wait" }
			}
		},
		"discord": {
			"emoji": "💬",
			"title": "Discord",
			"actions": {
				"react": {
					"label": "react",
					"detailKeys": [
						"channelId",
						"messageId",
						"emoji"
					]
				},
				"reactions": {
					"label": "reactions",
					"detailKeys": ["channelId", "messageId"]
				},
				"sticker": {
					"label": "sticker",
					"detailKeys": ["to", "stickerIds"]
				},
				"poll": {
					"label": "poll",
					"detailKeys": ["question", "to"]
				},
				"permissions": {
					"label": "permissions",
					"detailKeys": ["channelId"]
				},
				"readMessages": {
					"label": "read messages",
					"detailKeys": ["channelId", "limit"]
				},
				"sendMessage": {
					"label": "send",
					"detailKeys": ["to", "content"]
				},
				"editMessage": {
					"label": "edit",
					"detailKeys": ["channelId", "messageId"]
				},
				"deleteMessage": {
					"label": "delete",
					"detailKeys": ["channelId", "messageId"]
				},
				"threadCreate": {
					"label": "thread create",
					"detailKeys": ["channelId", "name"]
				},
				"threadList": {
					"label": "thread list",
					"detailKeys": ["guildId", "channelId"]
				},
				"threadReply": {
					"label": "thread reply",
					"detailKeys": ["channelId", "content"]
				},
				"pinMessage": {
					"label": "pin",
					"detailKeys": ["channelId", "messageId"]
				},
				"unpinMessage": {
					"label": "unpin",
					"detailKeys": ["channelId", "messageId"]
				},
				"listPins": {
					"label": "list pins",
					"detailKeys": ["channelId"]
				},
				"searchMessages": {
					"label": "search",
					"detailKeys": ["guildId", "content"]
				},
				"memberInfo": {
					"label": "member",
					"detailKeys": ["guildId", "userId"]
				},
				"roleInfo": {
					"label": "roles",
					"detailKeys": ["guildId"]
				},
				"emojiList": {
					"label": "emoji list",
					"detailKeys": ["guildId"]
				},
				"roleAdd": {
					"label": "role add",
					"detailKeys": [
						"guildId",
						"userId",
						"roleId"
					]
				},
				"roleRemove": {
					"label": "role remove",
					"detailKeys": [
						"guildId",
						"userId",
						"roleId"
					]
				},
				"channelInfo": {
					"label": "channel",
					"detailKeys": ["channelId"]
				},
				"channelList": {
					"label": "channels",
					"detailKeys": ["guildId"]
				},
				"voiceStatus": {
					"label": "voice",
					"detailKeys": ["guildId", "userId"]
				},
				"eventList": {
					"label": "events",
					"detailKeys": ["guildId"]
				},
				"eventCreate": {
					"label": "event create",
					"detailKeys": ["guildId", "name"]
				},
				"timeout": {
					"label": "timeout",
					"detailKeys": ["guildId", "userId"]
				},
				"kick": {
					"label": "kick",
					"detailKeys": ["guildId", "userId"]
				},
				"ban": {
					"label": "ban",
					"detailKeys": ["guildId", "userId"]
				}
			}
		}
	}
};

//#endregion
//#region src/agents/tool-display-common.ts
function asRecord(args) {
	return args && typeof args === "object" ? args : void 0;
}
function normalizeToolName(name) {
	return (name ?? "tool").trim();
}
function defaultTitle(name) {
	const cleaned = name.replace(/_/g, " ").trim();
	if (!cleaned) return "Tool";
	return cleaned.split(/\s+/).map((part) => part.length <= 2 && part.toUpperCase() === part ? part : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}
function normalizeVerb(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	return trimmed.replace(/_/g, " ");
}
function resolveActionArg(args) {
	if (!args || typeof args !== "object") return;
	const actionRaw = args.action;
	if (typeof actionRaw !== "string") return;
	return actionRaw.trim() || void 0;
}
function resolveToolVerbAndDetailForArgs(params) {
	return resolveToolVerbAndDetail({
		toolKey: params.toolKey,
		args: params.args,
		meta: params.meta,
		action: resolveActionArg(params.args),
		spec: params.spec,
		fallbackDetailKeys: params.fallbackDetailKeys,
		detailMode: params.detailMode,
		detailCoerce: params.detailCoerce,
		detailMaxEntries: params.detailMaxEntries,
		detailFormatKey: params.detailFormatKey
	});
}
function coerceDisplayValue(value, opts = {}) {
	const maxStringChars = opts.maxStringChars ?? 160;
	const maxArrayEntries = opts.maxArrayEntries ?? 3;
	if (value === null || value === void 0) return;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return;
		const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
		if (!firstLine) return;
		if (firstLine.length > maxStringChars) return `${firstLine.slice(0, Math.max(0, maxStringChars - 3))}…`;
		return firstLine;
	}
	if (typeof value === "boolean") {
		if (!value && !opts.includeFalse) return;
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return opts.includeNonFinite ? String(value) : void 0;
		if (value === 0 && !opts.includeZero) return;
		return String(value);
	}
	if (Array.isArray(value)) {
		const values = value.map((item) => coerceDisplayValue(item, opts)).filter((item) => Boolean(item));
		if (values.length === 0) return;
		const preview = values.slice(0, maxArrayEntries).join(", ");
		return values.length > maxArrayEntries ? `${preview}…` : preview;
	}
}
function lookupValueByPath(args, path) {
	if (!args || typeof args !== "object") return;
	let current = args;
	for (const segment of path.split(".")) {
		if (!segment) return;
		if (!current || typeof current !== "object") return;
		current = current[segment];
	}
	return current;
}
function formatDetailKey(raw, overrides = {}) {
	const last = raw.split(".").filter(Boolean).at(-1) ?? raw;
	const override = overrides[last];
	if (override) return override;
	return last.replace(/_/g, " ").replace(/-/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase() || last.toLowerCase();
}
function resolvePathArg(args) {
	const record = asRecord(args);
	if (!record) return;
	for (const candidate of [
		record.path,
		record.file_path,
		record.filePath
	]) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) return trimmed;
	}
}
function resolveReadDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const path = resolvePathArg(record);
	if (!path) return;
	const offsetRaw = typeof record.offset === "number" && Number.isFinite(record.offset) ? Math.floor(record.offset) : void 0;
	const limitRaw = typeof record.limit === "number" && Number.isFinite(record.limit) ? Math.floor(record.limit) : void 0;
	const offset = offsetRaw !== void 0 ? Math.max(1, offsetRaw) : void 0;
	const limit = limitRaw !== void 0 ? Math.max(1, limitRaw) : void 0;
	if (offset !== void 0 && limit !== void 0) return `${limit === 1 ? "line" : "lines"} ${offset}-${offset + limit - 1} from ${path}`;
	if (offset !== void 0) return `from line ${offset} in ${path}`;
	if (limit !== void 0) return `first ${limit} ${limit === 1 ? "line" : "lines"} of ${path}`;
	return `from ${path}`;
}
function resolveWriteDetail(toolKey, args) {
	const record = asRecord(args);
	if (!record) return;
	const path = resolvePathArg(record) ?? (typeof record.url === "string" ? record.url.trim() : void 0);
	if (!path) return;
	if (toolKey === "attach") return `from ${path}`;
	const destinationPrefix = toolKey === "edit" ? "in" : "to";
	const content = typeof record.content === "string" ? record.content : typeof record.newText === "string" ? record.newText : typeof record.new_string === "string" ? record.new_string : void 0;
	if (content && content.length > 0) return `${destinationPrefix} ${path} (${content.length} chars)`;
	return `${destinationPrefix} ${path}`;
}
function resolveWebSearchDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const query = typeof record.query === "string" ? record.query.trim() : void 0;
	const count = typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0 ? Math.floor(record.count) : void 0;
	if (!query) return;
	return count !== void 0 ? `for "${query}" (top ${count})` : `for "${query}"`;
}
function resolveWebFetchDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const url = typeof record.url === "string" ? record.url.trim() : void 0;
	if (!url) return;
	const mode = typeof record.extractMode === "string" ? record.extractMode.trim() : void 0;
	const maxChars = typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0 ? Math.floor(record.maxChars) : void 0;
	const suffix = [mode ? `mode ${mode}` : void 0, maxChars !== void 0 ? `max ${maxChars} chars` : void 0].filter((value) => Boolean(value)).join(", ");
	return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}
function stripOuterQuotes(value) {
	if (!value) return value;
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
	return trimmed;
}
function splitShellWords(input, maxWords = 48) {
	if (!input) return [];
	const words = [];
	let current = "";
	let quote;
	let escaped = false;
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = void 0;
			else current += char;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (!current) continue;
			words.push(current);
			if (words.length >= maxWords) return words;
			current = "";
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	return words;
}
function binaryName(token) {
	if (!token) return;
	const cleaned = stripOuterQuotes(token) ?? token;
	return (cleaned.split(/[/]/).at(-1) ?? cleaned).trim().toLowerCase();
}
function optionValue(words, names) {
	const lookup = new Set(names);
	for (let i = 0; i < words.length; i += 1) {
		const token = words[i];
		if (!token) continue;
		if (lookup.has(token)) {
			const value = words[i + 1];
			if (value && !value.startsWith("-")) return value;
			continue;
		}
		for (const name of names) if (name.startsWith("--") && token.startsWith(`${name}=`)) return token.slice(name.length + 1);
	}
}
function positionalArgs(words, from = 1, optionsWithValue = []) {
	const args = [];
	const takesValue = new Set(optionsWithValue);
	for (let i = from; i < words.length; i += 1) {
		const token = words[i];
		if (!token) continue;
		if (token === "--") {
			for (let j = i + 1; j < words.length; j += 1) {
				const candidate = words[j];
				if (candidate) args.push(candidate);
			}
			break;
		}
		if (token.startsWith("--")) {
			if (token.includes("=")) continue;
			if (takesValue.has(token)) i += 1;
			continue;
		}
		if (token.startsWith("-")) {
			if (takesValue.has(token)) i += 1;
			continue;
		}
		args.push(token);
	}
	return args;
}
function firstPositional(words, from = 1, optionsWithValue = []) {
	return positionalArgs(words, from, optionsWithValue)[0];
}
function trimLeadingEnv(words) {
	if (words.length === 0) return words;
	let index = 0;
	if (binaryName(words[0]) === "env") {
		index = 1;
		while (index < words.length) {
			const token = words[index];
			if (!token) break;
			if (token.startsWith("-")) {
				index += 1;
				continue;
			}
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
				index += 1;
				continue;
			}
			break;
		}
		return words.slice(index);
	}
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
	return words.slice(index);
}
function unwrapShellWrapper(command) {
	const words = splitShellWords(command, 10);
	if (words.length < 3) return command;
	const bin = binaryName(words[0]);
	if (!(bin === "bash" || bin === "sh" || bin === "zsh" || bin === "fish")) return command;
	const flagIndex = words.findIndex((token, index) => index > 0 && (token === "-c" || token === "-lc" || token === "-ic"));
	if (flagIndex === -1) return command;
	const inner = words.slice(flagIndex + 1).join(" ").trim();
	return inner ? stripOuterQuotes(inner) ?? command : command;
}
function scanTopLevelChars(command, visit) {
	let quote;
	let escaped = false;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = void 0;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (visit(char, i) === false) return;
	}
}
function splitTopLevelStages(command) {
	const parts = [];
	let start = 0;
	scanTopLevelChars(command, (char, index) => {
		if (char === ";") {
			parts.push(command.slice(start, index));
			start = index + 1;
			return true;
		}
		if ((char === "&" || char === "|") && command[index + 1] === char) {
			parts.push(command.slice(start, index));
			start = index + 2;
			return true;
		}
		return true;
	});
	parts.push(command.slice(start));
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
function splitTopLevelPipes(command) {
	const parts = [];
	let start = 0;
	scanTopLevelChars(command, (char, index) => {
		if (char === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
			parts.push(command.slice(start, index));
			start = index + 1;
		}
		return true;
	});
	parts.push(command.slice(start));
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
function parseChdirTarget(head) {
	const words = splitShellWords(head, 3);
	const bin = binaryName(words[0]);
	if (bin === "cd" || bin === "pushd") return words[1] || void 0;
}
function isChdirCommand(head) {
	const bin = binaryName(splitShellWords(head, 2)[0]);
	return bin === "cd" || bin === "pushd" || bin === "popd";
}
function isPopdCommand(head) {
	return binaryName(splitShellWords(head, 2)[0]) === "popd";
}
function stripShellPreamble(command) {
	let rest = command.trim();
	let chdirPath;
	for (let i = 0; i < 4; i += 1) {
		let first;
		scanTopLevelChars(rest, (char, idx) => {
			if (char === "&" && rest[idx + 1] === "&") {
				first = {
					index: idx,
					length: 2
				};
				return false;
			}
			if (char === "|" && rest[idx + 1] === "|") {
				first = {
					index: idx,
					length: 2,
					isOr: true
				};
				return false;
			}
			if (char === ";" || char === "\n") {
				first = {
					index: idx,
					length: 1
				};
				return false;
			}
		});
		const head = (first ? rest.slice(0, first.index) : rest).trim();
		const isChdir = (first ? !first.isOr : i > 0) && isChdirCommand(head);
		if (!(head.startsWith("set ") || head.startsWith("export ") || head.startsWith("unset ") || isChdir)) break;
		if (isChdir) if (isPopdCommand(head)) chdirPath = void 0;
		else chdirPath = parseChdirTarget(head) ?? chdirPath;
		rest = first ? rest.slice(first.index + first.length).trimStart() : "";
		if (!rest) break;
	}
	return {
		command: rest.trim(),
		chdirPath
	};
}
function summarizeKnownExec(words) {
	if (words.length === 0) return "run command";
	const bin = binaryName(words[0]) ?? "command";
	if (bin === "git") {
		const globalWithValue = new Set([
			"-C",
			"-c",
			"--git-dir",
			"--work-tree",
			"--namespace",
			"--config-env"
		]);
		const gitCwd = optionValue(words, ["-C"]);
		let sub;
		for (let i = 1; i < words.length; i += 1) {
			const token = words[i];
			if (!token) continue;
			if (token === "--") {
				sub = firstPositional(words, i + 1);
				break;
			}
			if (token.startsWith("--")) {
				if (token.includes("=")) continue;
				if (globalWithValue.has(token)) i += 1;
				continue;
			}
			if (token.startsWith("-")) {
				if (globalWithValue.has(token)) i += 1;
				continue;
			}
			sub = token;
			break;
		}
		const map = {
			status: "check git status",
			diff: "check git diff",
			log: "view git history",
			show: "show git object",
			branch: "list git branches",
			checkout: "switch git branch",
			switch: "switch git branch",
			commit: "create git commit",
			pull: "pull git changes",
			push: "push git changes",
			fetch: "fetch git changes",
			merge: "merge git changes",
			rebase: "rebase git branch",
			add: "stage git changes",
			restore: "restore git files",
			reset: "reset git state",
			stash: "stash git changes"
		};
		if (sub && map[sub]) return map[sub];
		if (!sub || sub.startsWith("/") || sub.startsWith("~") || sub.includes("/")) return gitCwd ? `run git command in ${gitCwd}` : "run git command";
		return `run git ${sub}`;
	}
	if (bin === "grep" || bin === "rg" || bin === "ripgrep") {
		const positional = positionalArgs(words, 1, [
			"-e",
			"--regexp",
			"-f",
			"--file",
			"-m",
			"--max-count",
			"-A",
			"--after-context",
			"-B",
			"--before-context",
			"-C",
			"--context"
		]);
		const pattern = optionValue(words, ["-e", "--regexp"]) ?? positional[0];
		const target = positional.length > 1 ? positional.at(-1) : void 0;
		if (pattern) return target ? `search "${pattern}" in ${target}` : `search "${pattern}"`;
		return "search text";
	}
	if (bin === "find") {
		const path = words[1] && !words[1].startsWith("-") ? words[1] : ".";
		const name = optionValue(words, ["-name", "-iname"]);
		return name ? `find files named "${name}" in ${path}` : `find files in ${path}`;
	}
	if (bin === "ls") {
		const target = firstPositional(words, 1);
		return target ? `list files in ${target}` : "list files";
	}
	if (bin === "head" || bin === "tail") {
		const lines = optionValue(words, ["-n", "--lines"]) ?? words.slice(1).find((token) => /^-\d+$/.test(token))?.slice(1);
		const positional = positionalArgs(words, 1, ["-n", "--lines"]);
		let target = positional.at(-1);
		if (target && /^\d+$/.test(target) && positional.length === 1) target = void 0;
		const side = bin === "head" ? "first" : "last";
		const unit = lines === "1" ? "line" : "lines";
		if (lines && target) return `show ${side} ${lines} ${unit} of ${target}`;
		if (lines) return `show ${side} ${lines} ${unit}`;
		if (target) return `show ${target}`;
		return `show ${bin} output`;
	}
	if (bin === "cat") {
		const target = firstPositional(words, 1);
		return target ? `show ${target}` : "show output";
	}
	if (bin === "sed") {
		const expression = optionValue(words, ["-e", "--expression"]);
		const positional = positionalArgs(words, 1, [
			"-e",
			"--expression",
			"-f",
			"--file"
		]);
		const script = expression ?? positional[0];
		const target = expression ? positional[0] : positional[1];
		if (script) {
			const compact = (stripOuterQuotes(script) ?? script).replace(/\s+/g, "");
			const range = compact.match(/^([0-9]+),([0-9]+)p$/);
			if (range) return target ? `print lines ${range[1]}-${range[2]} from ${target}` : `print lines ${range[1]}-${range[2]}`;
			const single = compact.match(/^([0-9]+)p$/);
			if (single) return target ? `print line ${single[1]} from ${target}` : `print line ${single[1]}`;
		}
		return target ? `run sed on ${target}` : "run sed transform";
	}
	if (bin === "printf" || bin === "echo") return "print text";
	if (bin === "cp" || bin === "mv") {
		const positional = positionalArgs(words, 1, [
			"-t",
			"--target-directory",
			"-S",
			"--suffix"
		]);
		const src = positional[0];
		const dst = positional[1];
		const action = bin === "cp" ? "copy" : "move";
		if (src && dst) return `${action} ${src} to ${dst}`;
		if (src) return `${action} ${src}`;
		return `${action} files`;
	}
	if (bin === "rm") {
		const target = firstPositional(words, 1);
		return target ? `remove ${target}` : "remove files";
	}
	if (bin === "mkdir") {
		const target = firstPositional(words, 1);
		return target ? `create folder ${target}` : "create folder";
	}
	if (bin === "touch") {
		const target = firstPositional(words, 1);
		return target ? `create file ${target}` : "create file";
	}
	if (bin === "curl" || bin === "wget") {
		const url = words.find((token) => /^https?:\/\//i.test(token));
		return url ? `fetch ${url}` : "fetch url";
	}
	if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
		const positional = positionalArgs(words, 1, [
			"--prefix",
			"-C",
			"--cwd",
			"--config"
		]);
		const sub = positional[0] ?? "command";
		return {
			install: "install dependencies",
			test: "run tests",
			build: "run build",
			start: "start app",
			lint: "run lint",
			run: positional[1] ? `run ${positional[1]}` : "run script"
		}[sub] ?? `run ${bin} ${sub}`;
	}
	if (bin === "node" || bin === "python" || bin === "python3" || bin === "ruby" || bin === "php") {
		if (words.slice(1).find((token) => token.startsWith("<<"))) return `run ${bin} inline script (heredoc)`;
		if ((bin === "node" ? optionValue(words, ["-e", "--eval"]) : bin === "python" || bin === "python3" ? optionValue(words, ["-c"]) : void 0) !== void 0) return `run ${bin} inline script`;
		const script = firstPositional(words, 1, bin === "node" ? [
			"-e",
			"--eval",
			"-m"
		] : [
			"-c",
			"-e",
			"--eval",
			"-m"
		]);
		if (!script) return `run ${bin}`;
		if (bin === "node") return `${words.includes("--check") || words.includes("-c") ? "check js syntax for" : "run node script"} ${script}`;
		return `run ${bin} ${script}`;
	}
	if (bin === "openclaw") {
		const sub = firstPositional(words, 1);
		return sub ? `run openclaw ${sub}` : "run openclaw";
	}
	const arg = firstPositional(words, 1);
	if (!arg || arg.length > 48) return `run ${bin}`;
	return /^[A-Za-z0-9._/-]+$/.test(arg) ? `run ${bin} ${arg}` : `run ${bin}`;
}
function summarizePipeline(stage) {
	const pipeline = splitTopLevelPipes(stage);
	if (pipeline.length > 1) return `${summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[0])))} -> ${summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[pipeline.length - 1])))}${pipeline.length > 2 ? ` (+${pipeline.length - 2} steps)` : ""}`;
	return summarizeKnownExec(trimLeadingEnv(splitShellWords(stage)));
}
function summarizeExecCommand(command) {
	const { command: cleaned, chdirPath } = stripShellPreamble(command);
	if (!cleaned) return chdirPath ? {
		text: "",
		chdirPath
	} : void 0;
	const stages = splitTopLevelStages(cleaned);
	if (stages.length === 0) return;
	const summaries = stages.map((stage) => summarizePipeline(stage));
	return {
		text: summaries.length === 1 ? summaries[0] : summaries.join(" → "),
		chdirPath,
		allGeneric: summaries.every((s) => isGenericSummary(s))
	};
}
/** Known summarizer prefixes that indicate a recognized command with useful context. */
const KNOWN_SUMMARY_PREFIXES = [
	"check git",
	"view git",
	"show git",
	"list git",
	"switch git",
	"create git",
	"pull git",
	"push git",
	"fetch git",
	"merge git",
	"rebase git",
	"stage git",
	"restore git",
	"reset git",
	"stash git",
	"search ",
	"find files",
	"list files",
	"show first",
	"show last",
	"print line",
	"print text",
	"copy ",
	"move ",
	"remove ",
	"create folder",
	"create file",
	"fetch http",
	"install dependencies",
	"run tests",
	"run build",
	"start app",
	"run lint",
	"run openclaw",
	"run node script",
	"run node ",
	"run python",
	"run ruby",
	"run php",
	"run sed",
	"run git ",
	"run npm ",
	"run pnpm ",
	"run yarn ",
	"run bun ",
	"check js syntax"
];
/** True when the summary is generic and the raw command would be more informative. */
function isGenericSummary(summary) {
	if (summary === "run command") return true;
	if (summary.startsWith("run ")) return !KNOWN_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix));
	return false;
}
/** Compact the raw command for display: collapse whitespace, trim long strings. */
function compactRawCommand(raw, maxLength = 120) {
	const oneLine = raw.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
function resolveExecDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const raw = typeof record.command === "string" ? record.command.trim() : void 0;
	if (!raw) return;
	const unwrapped = unwrapShellWrapper(raw);
	const result = summarizeExecCommand(unwrapped) ?? summarizeExecCommand(raw);
	const summary = result?.text || "run command";
	const cwd = (typeof record.workdir === "string" ? record.workdir : typeof record.cwd === "string" ? record.cwd : void 0)?.trim() || result?.chdirPath || void 0;
	const compact = compactRawCommand(unwrapped);
	if (result?.allGeneric !== false && isGenericSummary(summary)) return cwd ? `${compact} (in ${cwd})` : compact;
	const displaySummary = cwd ? `${summary} (in ${cwd})` : summary;
	if (compact && compact !== displaySummary && compact !== summary) return `${displaySummary}\n\n\`${compact}\``;
	return displaySummary;
}
function resolveActionSpec(spec, action) {
	if (!spec || !action) return;
	return spec.actions?.[action] ?? void 0;
}
function resolveDetailFromKeys(args, keys, opts) {
	if (opts.mode === "first") {
		for (const key of keys) {
			const display = coerceDisplayValue(lookupValueByPath(args, key), opts.coerce);
			if (display) return display;
		}
		return;
	}
	const entries = [];
	for (const key of keys) {
		const display = coerceDisplayValue(lookupValueByPath(args, key), opts.coerce);
		if (!display) continue;
		entries.push({
			label: opts.formatKey ? opts.formatKey(key) : key,
			value: display
		});
	}
	if (entries.length === 0) return;
	if (entries.length === 1) return entries[0].value;
	const seen = /* @__PURE__ */ new Set();
	const unique = [];
	for (const entry of entries) {
		const token = `${entry.label}:${entry.value}`;
		if (seen.has(token)) continue;
		seen.add(token);
		unique.push(entry);
	}
	if (unique.length === 0) return;
	return unique.slice(0, opts.maxEntries ?? 8).map((entry) => `${entry.label} ${entry.value}`).join(" · ");
}
function resolveToolVerbAndDetail(params) {
	const actionSpec = resolveActionSpec(params.spec, params.action);
	const fallbackVerb = params.toolKey === "web_search" ? "search" : params.toolKey === "web_fetch" ? "fetch" : params.toolKey.replace(/_/g, " ").replace(/\./g, " ");
	const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);
	let detail;
	if (params.toolKey === "exec") detail = resolveExecDetail(params.args);
	if (!detail && params.toolKey === "read") detail = resolveReadDetail(params.args);
	if (!detail && (params.toolKey === "write" || params.toolKey === "edit" || params.toolKey === "attach")) detail = resolveWriteDetail(params.toolKey, params.args);
	if (!detail && params.toolKey === "web_search") detail = resolveWebSearchDetail(params.args);
	if (!detail && params.toolKey === "web_fetch") detail = resolveWebFetchDetail(params.args);
	const detailKeys = actionSpec?.detailKeys ?? params.spec?.detailKeys ?? params.fallbackDetailKeys ?? [];
	if (!detail && detailKeys.length > 0) detail = resolveDetailFromKeys(params.args, detailKeys, {
		mode: params.detailMode,
		coerce: params.detailCoerce,
		maxEntries: params.detailMaxEntries,
		formatKey: params.detailFormatKey
	});
	if (!detail && params.meta) detail = params.meta;
	return {
		verb,
		detail
	};
}
function formatToolDetailText(detail, opts = {}) {
	if (!detail) return;
	const normalized = detail.includes(" · ") ? detail.split(" · ").map((part) => part.trim()).filter((part) => part.length > 0).join(", ") : detail;
	if (!normalized) return;
	return opts.prefixWithWith ? `with ${normalized}` : normalized;
}

//#endregion
//#region src/agents/tool-display-overrides.json
var tool_display_overrides_default = {
	version: 1,
	tools: {
		"exec": {
			"emoji": "🛠️",
			"title": "Exec",
			"detailKeys": ["command"]
		},
		"tool_call": {
			"emoji": "🧰",
			"title": "Tool Call",
			"detailKeys": []
		},
		"tool_call_update": {
			"emoji": "🧰",
			"title": "Tool Call",
			"detailKeys": []
		},
		"session_status": {
			"emoji": "📊",
			"title": "Session Status",
			"detailKeys": ["sessionKey", "model"]
		},
		"sessions_list": {
			"emoji": "🗂️",
			"title": "Sessions",
			"detailKeys": [
				"kinds",
				"limit",
				"activeMinutes",
				"messageLimit"
			]
		},
		"sessions_send": {
			"emoji": "📨",
			"title": "Session Send",
			"detailKeys": [
				"label",
				"sessionKey",
				"agentId",
				"timeoutSeconds"
			]
		},
		"sessions_history": {
			"emoji": "🧾",
			"title": "Session History",
			"detailKeys": [
				"sessionKey",
				"limit",
				"includeTools"
			]
		},
		"sessions_spawn": {
			"emoji": "🧑‍🔧",
			"title": "Sub-agent",
			"detailKeys": [
				"label",
				"task",
				"agentId",
				"model",
				"thinking",
				"runTimeoutSeconds",
				"cleanup"
			]
		},
		"subagents": {
			"emoji": "🤖",
			"title": "Subagents",
			"actions": {
				"list": {
					"label": "list",
					"detailKeys": ["recentMinutes"]
				},
				"kill": {
					"label": "kill",
					"detailKeys": ["target"]
				},
				"steer": {
					"label": "steer",
					"detailKeys": ["target"]
				}
			}
		},
		"agents_list": {
			"emoji": "🧭",
			"title": "Agents",
			"detailKeys": []
		},
		"memory_search": {
			"emoji": "🧠",
			"title": "Memory Search",
			"detailKeys": ["query"]
		},
		"memory_get": {
			"emoji": "📓",
			"title": "Memory Get",
			"detailKeys": [
				"path",
				"from",
				"lines"
			]
		},
		"web_search": {
			"emoji": "🔎",
			"title": "Web Search",
			"detailKeys": ["query", "count"]
		},
		"web_fetch": {
			"emoji": "📄",
			"title": "Web Fetch",
			"detailKeys": [
				"url",
				"extractMode",
				"maxChars"
			]
		},
		"message": {
			"emoji": "✉️",
			"title": "Message",
			"actions": {
				"send": {
					"label": "send",
					"detailKeys": [
						"provider",
						"to",
						"media",
						"replyTo",
						"threadId"
					]
				},
				"poll": {
					"label": "poll",
					"detailKeys": [
						"provider",
						"to",
						"pollQuestion"
					]
				},
				"react": {
					"label": "react",
					"detailKeys": [
						"provider",
						"to",
						"messageId",
						"emoji",
						"remove"
					]
				},
				"reactions": {
					"label": "reactions",
					"detailKeys": [
						"provider",
						"to",
						"messageId",
						"limit"
					]
				},
				"read": {
					"label": "read",
					"detailKeys": [
						"provider",
						"to",
						"limit"
					]
				},
				"edit": {
					"label": "edit",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"delete": {
					"label": "delete",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"pin": {
					"label": "pin",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"unpin": {
					"label": "unpin",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"list-pins": {
					"label": "list pins",
					"detailKeys": ["provider", "to"]
				},
				"permissions": {
					"label": "permissions",
					"detailKeys": [
						"provider",
						"channelId",
						"to"
					]
				},
				"thread-create": {
					"label": "thread create",
					"detailKeys": [
						"provider",
						"channelId",
						"threadName"
					]
				},
				"thread-list": {
					"label": "thread list",
					"detailKeys": [
						"provider",
						"guildId",
						"channelId"
					]
				},
				"thread-reply": {
					"label": "thread reply",
					"detailKeys": [
						"provider",
						"channelId",
						"messageId"
					]
				},
				"search": {
					"label": "search",
					"detailKeys": [
						"provider",
						"guildId",
						"query"
					]
				},
				"sticker": {
					"label": "sticker",
					"detailKeys": [
						"provider",
						"to",
						"stickerId"
					]
				},
				"member-info": {
					"label": "member",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"role-info": {
					"label": "roles",
					"detailKeys": ["provider", "guildId"]
				},
				"emoji-list": {
					"label": "emoji list",
					"detailKeys": ["provider", "guildId"]
				},
				"emoji-upload": {
					"label": "emoji upload",
					"detailKeys": [
						"provider",
						"guildId",
						"emojiName"
					]
				},
				"sticker-upload": {
					"label": "sticker upload",
					"detailKeys": [
						"provider",
						"guildId",
						"stickerName"
					]
				},
				"role-add": {
					"label": "role add",
					"detailKeys": [
						"provider",
						"guildId",
						"userId",
						"roleId"
					]
				},
				"role-remove": {
					"label": "role remove",
					"detailKeys": [
						"provider",
						"guildId",
						"userId",
						"roleId"
					]
				},
				"channel-info": {
					"label": "channel",
					"detailKeys": ["provider", "channelId"]
				},
				"channel-list": {
					"label": "channels",
					"detailKeys": ["provider", "guildId"]
				},
				"voice-status": {
					"label": "voice",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"event-list": {
					"label": "events",
					"detailKeys": ["provider", "guildId"]
				},
				"event-create": {
					"label": "event create",
					"detailKeys": [
						"provider",
						"guildId",
						"eventName"
					]
				},
				"timeout": {
					"label": "timeout",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"kick": {
					"label": "kick",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"ban": {
					"label": "ban",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				}
			}
		},
		"apply_patch": {
			"emoji": "🩹",
			"title": "Apply Patch",
			"detailKeys": []
		}
	}
};

//#endregion
//#region src/agents/tool-display.ts
const SHARED_TOOL_DISPLAY_CONFIG = tool_display_default;
const TOOL_DISPLAY_OVERRIDES = tool_display_overrides_default;
const FALLBACK = TOOL_DISPLAY_OVERRIDES.fallback ?? SHARED_TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = Object.assign({}, SHARED_TOOL_DISPLAY_CONFIG.tools, TOOL_DISPLAY_OVERRIDES.tools);
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
	const key = name.toLowerCase();
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
	return detail ? `${display.emoji} ${display.label}: ${detail}` : `${display.emoji} ${display.label}`;
}

//#endregion
export { formatToolSummary as n, resolveToolDisplay as r, formatToolDetail as t };