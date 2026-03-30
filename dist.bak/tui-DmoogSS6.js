import { c as normalizeUsageDisplay, r as listThinkingLevelLabels, t as formatThinkingLevels, u as resolveResponseUsageMode } from "./thinking-EAliFiVK.js";
import { d as resolveDefaultAgentId } from "./agent-scope-D8K2SjR7.js";
import { l as stripAnsi$1, u as visibleWidth } from "./subsystem-LTWJBEIv.js";
import { c as normalizeMainKey, r as buildAgentMainSessionKey, s as normalizeAgentId, w as parseAgentSessionKey } from "./session-key-D5gwKk5E.js";
import { zt as loadConfig } from "./model-selection-DILdVnl8.js";
import { r as VERSION } from "./env-vars-Duxu9t5m.js";
import { f as GATEWAY_CLIENT_CAPS, h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-C0KMGsnJ.js";
import { _ as formatRawAssistantErrorForUi } from "./pi-embedded-helpers-D_vwTcIu.js";
import { i as stripLeadingInboundMetadata } from "./chat-envelope-CZCr0x5F.js";
import { n as resolveToolDisplay, t as formatToolDetail } from "./tool-display-CERZKWmU.js";
import { a as listChatCommands, o as listChatCommandsForConfig } from "./commands-registry-DvQussPa.js";
import { At as PROTOCOL_VERSION, t as GatewayClient } from "./client-xAUDLDK2.js";
import { i as ensureExplicitGatewayAuth, o as resolveExplicitGatewayAuth, t as buildGatewayConnectionDetails } from "./call-BP56BqJF.js";
import { n as formatTimeAgo, t as formatRelativeTimestamp } from "./format-relative-CxLpEQOX.js";
import { n as formatTokenCount } from "./usage-format-BOkQhsjC.js";
import chalk from "chalk";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Box, CombinedAutocompleteProvider, Container, Editor, Input, Key, Loader, Markdown, ProcessTerminal, SelectList, SettingsList, Spacer, TUI, Text, getEditorKeybindings, isKeyRelease, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { highlight, supportsLanguage } from "cli-highlight";

//#region src/tui/commands.ts
const VERBOSE_LEVELS = ["on", "off"];
const REASONING_LEVELS = ["on", "off"];
const ELEVATED_LEVELS = [
	"on",
	"off",
	"ask",
	"full"
];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_FOOTER_LEVELS = [
	"off",
	"tokens",
	"full"
];
const COMMAND_ALIASES = { elev: "elevated" };
function createLevelCompletion(levels) {
	return (prefix) => levels.filter((value) => value.startsWith(prefix.toLowerCase())).map((value) => ({
		value,
		label: value
	}));
}
function parseCommand(input) {
	const trimmed = input.replace(/^\//, "").trim();
	if (!trimmed) return {
		name: "",
		args: ""
	};
	const [name, ...rest] = trimmed.split(/\s+/);
	const normalized = name.toLowerCase();
	return {
		name: COMMAND_ALIASES[normalized] ?? normalized,
		args: rest.join(" ").trim()
	};
}
function getSlashCommands(options = {}) {
	const thinkLevels = listThinkingLevelLabels(options.provider, options.model);
	const verboseCompletions = createLevelCompletion(VERBOSE_LEVELS);
	const reasoningCompletions = createLevelCompletion(REASONING_LEVELS);
	const usageCompletions = createLevelCompletion(USAGE_FOOTER_LEVELS);
	const elevatedCompletions = createLevelCompletion(ELEVATED_LEVELS);
	const activationCompletions = createLevelCompletion(ACTIVATION_LEVELS);
	const commands = [
		{
			name: "help",
			description: "Show slash command help"
		},
		{
			name: "status",
			description: "Show gateway status summary"
		},
		{
			name: "agent",
			description: "Switch agent (or open picker)"
		},
		{
			name: "agents",
			description: "Open agent picker"
		},
		{
			name: "session",
			description: "Switch session (or open picker)"
		},
		{
			name: "sessions",
			description: "Open session picker"
		},
		{
			name: "model",
			description: "Set model (or open picker)"
		},
		{
			name: "models",
			description: "Open model picker"
		},
		{
			name: "think",
			description: "Set thinking level",
			getArgumentCompletions: (prefix) => thinkLevels.filter((v) => v.startsWith(prefix.toLowerCase())).map((value) => ({
				value,
				label: value
			}))
		},
		{
			name: "verbose",
			description: "Set verbose on/off",
			getArgumentCompletions: verboseCompletions
		},
		{
			name: "reasoning",
			description: "Set reasoning on/off",
			getArgumentCompletions: reasoningCompletions
		},
		{
			name: "usage",
			description: "Toggle per-response usage line",
			getArgumentCompletions: usageCompletions
		},
		{
			name: "elevated",
			description: "Set elevated on/off/ask/full",
			getArgumentCompletions: elevatedCompletions
		},
		{
			name: "elev",
			description: "Alias for /elevated",
			getArgumentCompletions: elevatedCompletions
		},
		{
			name: "activation",
			description: "Set group activation",
			getArgumentCompletions: activationCompletions
		},
		{
			name: "abort",
			description: "Abort active run"
		},
		{
			name: "new",
			description: "Reset the session"
		},
		{
			name: "reset",
			description: "Reset the session"
		},
		{
			name: "settings",
			description: "Open settings"
		},
		{
			name: "exit",
			description: "Exit the TUI"
		},
		{
			name: "quit",
			description: "Exit the TUI"
		}
	];
	const seen = new Set(commands.map((command) => command.name));
	const gatewayCommands = options.cfg ? listChatCommandsForConfig(options.cfg) : listChatCommands();
	for (const command of gatewayCommands) {
		const aliases = command.textAliases.length > 0 ? command.textAliases : [`/${command.key}`];
		for (const alias of aliases) {
			const name = alias.replace(/^\//, "").trim();
			if (!name || seen.has(name)) continue;
			seen.add(name);
			commands.push({
				name,
				description: command.description
			});
		}
	}
	return commands;
}
function helpText(options = {}) {
	return [
		"Slash commands:",
		"/help",
		"/commands",
		"/status",
		"/agent <id> (or /agents)",
		"/session <key> (or /sessions)",
		"/model <provider/model> (or /models)",
		`/think <${formatThinkingLevels(options.provider, options.model, "|")}>`,
		"/verbose <on|off>",
		"/reasoning <on|off>",
		"/usage <off|tokens|full>",
		"/elevated <on|off|ask|full>",
		"/elev <on|off|ask|full>",
		"/activation <mention|always>",
		"/new or /reset",
		"/abort",
		"/settings",
		"/exit"
	].join("\n");
}

//#endregion
//#region src/tui/theme/syntax-theme.ts
/**
* Syntax highlighting theme for code blocks.
* Uses chalk functions to style different token types.
*/
function createSyntaxTheme(fallback) {
	return {
		keyword: chalk.hex("#C586C0"),
		built_in: chalk.hex("#4EC9B0"),
		type: chalk.hex("#4EC9B0"),
		literal: chalk.hex("#569CD6"),
		number: chalk.hex("#B5CEA8"),
		string: chalk.hex("#CE9178"),
		regexp: chalk.hex("#D16969"),
		symbol: chalk.hex("#B5CEA8"),
		class: chalk.hex("#4EC9B0"),
		function: chalk.hex("#DCDCAA"),
		title: chalk.hex("#DCDCAA"),
		params: chalk.hex("#9CDCFE"),
		comment: chalk.hex("#6A9955"),
		doctag: chalk.hex("#608B4E"),
		meta: chalk.hex("#9CDCFE"),
		"meta-keyword": chalk.hex("#C586C0"),
		"meta-string": chalk.hex("#CE9178"),
		section: chalk.hex("#DCDCAA"),
		tag: chalk.hex("#569CD6"),
		name: chalk.hex("#9CDCFE"),
		attr: chalk.hex("#9CDCFE"),
		attribute: chalk.hex("#9CDCFE"),
		variable: chalk.hex("#9CDCFE"),
		bullet: chalk.hex("#D7BA7D"),
		code: chalk.hex("#CE9178"),
		emphasis: chalk.italic,
		strong: chalk.bold,
		formula: chalk.hex("#C586C0"),
		link: chalk.hex("#4EC9B0"),
		quote: chalk.hex("#6A9955"),
		addition: chalk.hex("#B5CEA8"),
		deletion: chalk.hex("#F44747"),
		"selector-tag": chalk.hex("#D7BA7D"),
		"selector-id": chalk.hex("#D7BA7D"),
		"selector-class": chalk.hex("#D7BA7D"),
		"selector-attr": chalk.hex("#D7BA7D"),
		"selector-pseudo": chalk.hex("#D7BA7D"),
		"template-tag": chalk.hex("#C586C0"),
		"template-variable": chalk.hex("#9CDCFE"),
		default: fallback
	};
}

//#endregion
//#region src/tui/theme/theme.ts
const palette = {
	text: "#E8E3D5",
	dim: "#7B7F87",
	accent: "#F6C453",
	accentSoft: "#F2A65A",
	border: "#3C414B",
	userBg: "#2B2F36",
	userText: "#F3EEE0",
	systemText: "#9BA3B2",
	toolPendingBg: "#1F2A2F",
	toolSuccessBg: "#1E2D23",
	toolErrorBg: "#2F1F1F",
	toolTitle: "#F6C453",
	toolOutput: "#E1DACB",
	quote: "#8CC8FF",
	quoteBorder: "#3B4D6B",
	code: "#F0C987",
	codeBlock: "#1E232A",
	codeBorder: "#343A45",
	link: "#7DD3A5",
	error: "#F97066",
	success: "#7DD3A5"
};
const fg = (hex) => (text) => chalk.hex(hex)(text);
const bg = (hex) => (text) => chalk.bgHex(hex)(text);
const syntaxTheme = createSyntaxTheme(fg(palette.code));
/**
* Highlight code with syntax coloring.
* Returns an array of lines with ANSI escape codes.
*/
function highlightCode(code, lang) {
	try {
		return highlight(code, {
			language: lang && supportsLanguage(lang) ? lang : void 0,
			theme: syntaxTheme,
			ignoreIllegals: true
		}).split("\n");
	} catch {
		return code.split("\n").map((line) => fg(palette.code)(line));
	}
}
const theme = {
	fg: fg(palette.text),
	assistantText: (text) => text,
	dim: fg(palette.dim),
	accent: fg(palette.accent),
	accentSoft: fg(palette.accentSoft),
	success: fg(palette.success),
	error: fg(palette.error),
	header: (text) => chalk.bold(fg(palette.accent)(text)),
	system: fg(palette.systemText),
	userBg: bg(palette.userBg),
	userText: fg(palette.userText),
	toolTitle: fg(palette.toolTitle),
	toolOutput: fg(palette.toolOutput),
	toolPendingBg: bg(palette.toolPendingBg),
	toolSuccessBg: bg(palette.toolSuccessBg),
	toolErrorBg: bg(palette.toolErrorBg),
	border: fg(palette.border),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text)
};
const markdownTheme = {
	heading: (text) => chalk.bold(fg(palette.accent)(text)),
	link: (text) => fg(palette.link)(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => fg(palette.code)(text),
	codeBlock: (text) => fg(palette.code)(text),
	codeBlockBorder: (text) => fg(palette.codeBorder)(text),
	quote: (text) => fg(palette.quote)(text),
	quoteBorder: (text) => fg(palette.quoteBorder)(text),
	hr: (text) => fg(palette.border)(text),
	listBullet: (text) => fg(palette.accentSoft)(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
	highlightCode
};
const baseSelectListTheme = {
	selectedPrefix: (text) => fg(palette.accent)(text),
	selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
	description: (text) => fg(palette.dim)(text),
	scrollInfo: (text) => fg(palette.dim)(text),
	noMatch: (text) => fg(palette.dim)(text)
};
const selectListTheme = baseSelectListTheme;
const filterableSelectListTheme = {
	...baseSelectListTheme,
	filterLabel: (text) => fg(palette.dim)(text)
};
const settingsListTheme = {
	label: (text, selected) => selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text),
	value: (text, selected) => selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text),
	description: (text) => fg(palette.systemText)(text),
	cursor: fg(palette.accent)("→ "),
	hint: (text) => fg(palette.dim)(text)
};
const editorTheme = {
	borderColor: (text) => fg(palette.border)(text),
	selectList: selectListTheme
};
const searchableSelectListTheme = {
	...baseSelectListTheme,
	searchPrompt: (text) => fg(palette.accentSoft)(text),
	searchInput: (text) => fg(palette.text)(text),
	matchHighlight: (text) => chalk.bold(fg(palette.accent)(text))
};

//#endregion
//#region src/tui/osc8-hyperlinks.ts
const SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?(?:\\x07|\\x1b\\\\)";
const ANSI_RE = new RegExp(`${SGR_PATTERN}|${OSC8_PATTERN}`, "g");
const SGR_START_RE = new RegExp(`^${SGR_PATTERN}`);
const OSC8_START_RE = new RegExp(`^${OSC8_PATTERN}`);
/**
* Extract all unique URLs from raw markdown text.
* Finds both bare URLs and markdown link hrefs [text](url).
*/
function extractUrls(markdown) {
	const urls = /* @__PURE__ */ new Set();
	const mdLinkRe = /\[(?:[^\]]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
	let m;
	while ((m = mdLinkRe.exec(markdown)) !== null) urls.add(m[1]);
	const stripped = markdown.replace(/\[(?:[^\]]*)\]\(\s*<?https?:\/\/[^)\s>]+>?(?:\s+["'][^"']*["'])?\s*\)/g, "");
	const bareRe = /https?:\/\/[^\s)\]>]+/g;
	while ((m = bareRe.exec(stripped)) !== null) urls.add(m[0]);
	return [...urls];
}
/** Strip ANSI SGR and OSC 8 sequences to get visible text. */
function stripAnsi(input) {
	return input.replace(ANSI_RE, "");
}
/**
* Find URL ranges in a line's visible text, handling cross-line URL splits.
*/
function findUrlRanges(visibleText, knownUrls, pending) {
	const ranges = [];
	let newPending = null;
	let searchFrom = 0;
	if (pending) {
		const remaining = pending.url.slice(pending.consumed);
		const trimmed = visibleText.trimStart();
		const leadingSpaces = visibleText.length - trimmed.length;
		let matchLen = 0;
		for (let j = 0; j < remaining.length && j < trimmed.length; j++) if (remaining[j] === trimmed[j]) matchLen++;
		else break;
		if (matchLen > 0) {
			ranges.push({
				start: leadingSpaces,
				end: leadingSpaces + matchLen,
				url: pending.url
			});
			searchFrom = leadingSpaces + matchLen;
			if (pending.consumed + matchLen < pending.url.length) newPending = {
				url: pending.url,
				consumed: pending.consumed + matchLen
			};
		}
	}
	const urlRe = /https?:\/\/[^\s)\]>]+/g;
	urlRe.lastIndex = searchFrom;
	let match;
	while ((match = urlRe.exec(visibleText)) !== null) {
		const fragment = match[0];
		const start = match.index;
		let resolvedUrl = fragment;
		let found = false;
		for (const known of knownUrls) if (known === fragment) {
			resolvedUrl = known;
			found = true;
			break;
		}
		if (!found) {
			let bestLen = 0;
			for (const known of knownUrls) if (known.startsWith(fragment) && known.length > bestLen) {
				resolvedUrl = known;
				bestLen = known.length;
				found = true;
			}
		}
		if (!found) {
			let bestLen = 0;
			for (const known of knownUrls) if (fragment.startsWith(known) && known.length > bestLen) {
				resolvedUrl = known;
				bestLen = known.length;
			}
		}
		ranges.push({
			start,
			end: start + fragment.length,
			url: resolvedUrl
		});
		if (resolvedUrl.length > fragment.length && resolvedUrl.startsWith(fragment)) newPending = {
			url: resolvedUrl,
			consumed: fragment.length
		};
	}
	return {
		ranges,
		pending: newPending
	};
}
/**
* Apply OSC 8 hyperlink sequences to a line based on visible-text URL ranges.
* Walks through the raw string character by character, inserting OSC 8
* open/close sequences at URL range boundaries while preserving ANSI codes.
*/
function applyOsc8Ranges(line, ranges) {
	if (ranges.length === 0) return line;
	const urlAt = /* @__PURE__ */ new Map();
	for (const r of ranges) for (let p = r.start; p < r.end; p++) urlAt.set(p, r.url);
	let result = "";
	let visiblePos = 0;
	let activeUrl = null;
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 27) {
			const sgr = line.slice(i).match(SGR_START_RE);
			if (sgr) {
				result += sgr[0];
				i += sgr[0].length;
				continue;
			}
			const osc = line.slice(i).match(OSC8_START_RE);
			if (osc) {
				result += osc[0];
				i += osc[0].length;
				continue;
			}
		}
		const targetUrl = urlAt.get(visiblePos) ?? null;
		if (targetUrl !== activeUrl) {
			if (activeUrl !== null) result += "\x1B]8;;\x07";
			if (targetUrl !== null) result += `\x1b]8;;${targetUrl}\x07`;
			activeUrl = targetUrl;
		}
		result += line[i];
		visiblePos++;
		i++;
	}
	if (activeUrl !== null) result += "\x1B]8;;\x07";
	return result;
}
/**
* Add OSC 8 hyperlinks to rendered lines using a pre-extracted URL list.
*
* For each line, finds URL-like substrings in the visible text, matches them
* against known URLs, and wraps each fragment with OSC 8 escape sequences.
* Handles URLs broken across multiple lines by pi-tui's word wrapping.
*/
function addOsc8Hyperlinks(lines, urls) {
	if (urls.length === 0) return lines;
	let pending = null;
	return lines.map((line) => {
		const result = findUrlRanges(stripAnsi(line), urls, pending);
		pending = result.pending;
		return applyOsc8Ranges(line, result.ranges);
	});
}

//#endregion
//#region src/tui/components/hyperlink-markdown.ts
/**
* Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
* hyperlinks to rendered output, making URLs clickable even when broken
* across multiple lines by word wrapping.
*/
var HyperlinkMarkdown = class {
	constructor(text, paddingX, paddingY, theme, options) {
		this.inner = new Markdown(text, paddingX, paddingY, theme, options);
		this.urls = extractUrls(text);
	}
	render(width) {
		return addOsc8Hyperlinks(this.inner.render(width), this.urls);
	}
	setText(text) {
		this.inner.setText(text);
		this.urls = extractUrls(text);
	}
	invalidate() {
		this.inner.invalidate();
	}
};

//#endregion
//#region src/tui/components/assistant-message.ts
var AssistantMessageComponent = class extends Container {
	constructor(text) {
		super();
		this.body = new HyperlinkMarkdown(text, 1, 0, markdownTheme, { color: (line) => theme.assistantText(line) });
		this.addChild(new Spacer(1));
		this.addChild(this.body);
	}
	setText(text) {
		this.body.setText(text);
	}
};

//#endregion
//#region src/tui/tui-formatters.ts
const REPLACEMENT_CHAR_RE = /\uFFFD/g;
const MAX_TOKEN_CHARS = 32;
const LONG_TOKEN_RE = /\S{33,}/g;
const LONG_TOKEN_TEST_RE = /\S{33,}/;
const BINARY_LINE_REPLACEMENT_THRESHOLD = 12;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const RTL_ISOLATE_START = "⁧";
const RTL_ISOLATE_END = "⁩";
function hasControlChars(text) {
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code <= 31 && code !== 9 && code !== 10 && code !== 13 || code >= 127 && code <= 159) return true;
	}
	return false;
}
function stripControlChars(text) {
	if (!hasControlChars(text)) return text;
	let sanitized = "";
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (!(code <= 31 && code !== 9 && code !== 10 && code !== 13) && !(code >= 127 && code <= 159)) sanitized += char;
	}
	return sanitized;
}
function chunkToken(token, maxChars) {
	if (token.length <= maxChars) return [token];
	const chunks = [];
	for (let i = 0; i < token.length; i += maxChars) chunks.push(token.slice(i, i + maxChars));
	return chunks;
}
function isCopySensitiveToken(token) {
	if (URL_PREFIX_RE.test(token)) return true;
	if (token.startsWith("/") || token.startsWith("~/") || token.startsWith("./") || token.startsWith("../")) return true;
	if (WINDOWS_DRIVE_RE.test(token) || token.startsWith("\\\\")) return true;
	if (token.includes("/") || token.includes("\\")) return true;
	return token.includes("_") && FILE_LIKE_RE.test(token);
}
function normalizeLongTokenForDisplay(token) {
	if (isCopySensitiveToken(token)) return token;
	return chunkToken(token, MAX_TOKEN_CHARS).join(" ");
}
function redactBinaryLikeLine(line) {
	const replacementCount = (line.match(REPLACEMENT_CHAR_RE) || []).length;
	if (replacementCount >= BINARY_LINE_REPLACEMENT_THRESHOLD && replacementCount * 2 >= line.length) return "[binary data omitted]";
	return line;
}
function isolateRtlLine(line) {
	if (!RTL_SCRIPT_RE.test(line) || BIDI_CONTROL_RE.test(line)) return line;
	return `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}`;
}
function applyRtlIsolation(text) {
	if (!RTL_SCRIPT_RE.test(text)) return text;
	return text.split("\n").map((line) => isolateRtlLine(line)).join("\n");
}
function sanitizeRenderableText(text) {
	if (!text) return text;
	const hasAnsi = text.includes("\x1B");
	const hasReplacementChars = text.includes("�");
	const hasLongTokens = LONG_TOKEN_TEST_RE.test(text);
	const hasControls = hasControlChars(text);
	if (!hasAnsi && !hasReplacementChars && !hasLongTokens && !hasControls) return applyRtlIsolation(text);
	const withoutAnsi = hasAnsi ? stripAnsi$1(text) : text;
	const withoutControlChars = hasControls ? stripControlChars(withoutAnsi) : withoutAnsi;
	const redacted = hasReplacementChars ? withoutControlChars.split("\n").map((line) => redactBinaryLikeLine(line)).join("\n") : withoutControlChars;
	return applyRtlIsolation(LONG_TOKEN_TEST_RE.test(redacted) ? redacted.replace(LONG_TOKEN_RE, normalizeLongTokenForDisplay) : redacted);
}
function resolveFinalAssistantText(params) {
	const finalText = params.finalText ?? "";
	if (finalText.trim()) return finalText;
	const streamedText = params.streamedText ?? "";
	if (streamedText.trim()) return streamedText;
	return "(no output)";
}
function composeThinkingAndContent(params) {
	const thinkingText = params.thinkingText?.trim() ?? "";
	const contentText = params.contentText?.trim() ?? "";
	const parts = [];
	if (params.showThinking && thinkingText) parts.push(`[thinking]\n${thinkingText}`);
	if (contentText) parts.push(contentText);
	return parts.join("\n\n").trim();
}
function asMessageRecord(message) {
	if (!message || typeof message !== "object") return;
	return message;
}
function resolveMessageRecord(message) {
	const record = asMessageRecord(message);
	if (!record) return;
	return {
		record,
		content: record.content
	};
}
function formatAssistantErrorFromRecord(record) {
	if ((typeof record.stopReason === "string" ? record.stopReason : "") !== "error") return "";
	return formatRawAssistantErrorForUi(typeof record.errorMessage === "string" ? record.errorMessage : "");
}
function collectSanitizedBlockStrings(params) {
	if (!Array.isArray(params.content)) return [];
	const parts = [];
	for (const block of params.content) {
		if (!block || typeof block !== "object") continue;
		const rec = block;
		if (rec.type === params.blockType && typeof rec[params.valueKey] === "string") parts.push(sanitizeRenderableText(rec[params.valueKey]));
	}
	return parts;
}
/**
* Extract ONLY thinking blocks from message content.
* Model-agnostic: returns empty string if no thinking blocks exist.
*/
function extractThinkingFromMessage(message) {
	const resolved = resolveMessageRecord(message);
	if (!resolved) return "";
	const { content } = resolved;
	if (typeof content === "string") return "";
	return collectSanitizedBlockStrings({
		content,
		blockType: "thinking",
		valueKey: "thinking"
	}).join("\n").trim();
}
/**
* Extract ONLY text content blocks from message (excludes thinking).
* Model-agnostic: works for any model with text content blocks.
*/
function extractContentFromMessage(message) {
	const resolved = resolveMessageRecord(message);
	if (!resolved) return "";
	const { record, content } = resolved;
	if (typeof content === "string") return sanitizeRenderableText(content).trim();
	const parts = collectSanitizedBlockStrings({
		content,
		blockType: "text",
		valueKey: "text"
	});
	if (parts.length > 0) return parts.join("\n").trim();
	return formatAssistantErrorFromRecord(record);
}
function extractTextBlocks(content, opts) {
	if (typeof content === "string") return sanitizeRenderableText(content).trim();
	if (!Array.isArray(content)) return "";
	const textParts = collectSanitizedBlockStrings({
		content,
		blockType: "text",
		valueKey: "text"
	});
	return composeThinkingAndContent({
		thinkingText: (opts?.includeThinking === true ? collectSanitizedBlockStrings({
			content,
			blockType: "thinking",
			valueKey: "thinking"
		}) : []).join("\n").trim(),
		contentText: textParts.join("\n").trim(),
		showThinking: opts?.includeThinking ?? false
	});
}
function extractTextFromMessage(message, opts) {
	const record = asMessageRecord(message);
	if (!record) return "";
	const text = extractTextBlocks(record.content, opts);
	if (text) {
		if (record.role === "user") return stripLeadingInboundMetadata(text);
		return text;
	}
	const errorText = formatAssistantErrorFromRecord(record);
	if (!errorText) return "";
	return errorText;
}
function isCommandMessage(message) {
	if (!message || typeof message !== "object") return false;
	return message.command === true;
}
function formatTokens(total, context) {
	if (total == null && context == null) return "tokens ?";
	const totalLabel = total == null ? "?" : formatTokenCount(total);
	if (context == null) return `tokens ${totalLabel}`;
	const pct = typeof total === "number" && context > 0 ? Math.min(999, Math.round(total / context * 100)) : null;
	return `tokens ${totalLabel}/${formatTokenCount(context)}${pct !== null ? ` (${pct}%)` : ""}`;
}
function formatContextUsageLine(params) {
	const totalLabel = typeof params.total === "number" ? formatTokenCount(params.total) : "?";
	const ctxLabel = typeof params.context === "number" ? formatTokenCount(params.context) : "?";
	const pct = typeof params.percent === "number" ? Math.min(999, Math.round(params.percent)) : null;
	const extra = [typeof params.remaining === "number" ? `${formatTokenCount(params.remaining)} left` : null, pct !== null ? `${pct}%` : null].filter(Boolean).join(", ");
	return `tokens ${totalLabel}/${ctxLabel}${extra ? ` (${extra})` : ""}`;
}
function asString(value, fallback = "") {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

//#endregion
//#region src/tui/components/tool-execution.ts
const PREVIEW_LINES = 12;
function formatArgs(toolName, args) {
	const detail = formatToolDetail(resolveToolDisplay({
		name: toolName,
		args
	}));
	if (detail) return sanitizeRenderableText(detail);
	if (!args || typeof args !== "object") return "";
	try {
		return sanitizeRenderableText(JSON.stringify(args));
	} catch {
		return "";
	}
}
function extractText(result) {
	if (!result?.content) return "";
	const lines = [];
	for (const entry of result.content) if (entry.type === "text" && entry.text) lines.push(sanitizeRenderableText(entry.text));
	else if (entry.type === "image") {
		const mime = entry.mimeType ?? "image";
		const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
		const omitted = entry.omitted ? " (omitted)" : "";
		lines.push(`[${mime}${size}${omitted}]`);
	}
	return lines.join("\n").trim();
}
var ToolExecutionComponent = class extends Container {
	constructor(toolName, args) {
		super();
		this.expanded = false;
		this.isError = false;
		this.isPartial = true;
		this.toolName = toolName;
		this.args = args;
		this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
		this.header = new Text("", 0, 0);
		this.argsLine = new Text("", 0, 0);
		this.output = new Markdown("", 0, 0, markdownTheme, { color: (line) => theme.toolOutput(line) });
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.box.addChild(this.header);
		this.box.addChild(this.argsLine);
		this.box.addChild(this.output);
		this.refresh();
	}
	setArgs(args) {
		this.args = args;
		this.refresh();
	}
	setExpanded(expanded) {
		this.expanded = expanded;
		this.refresh();
	}
	setResult(result, opts) {
		this.result = result;
		this.isPartial = false;
		this.isError = Boolean(opts?.isError);
		this.refresh();
	}
	setPartialResult(result) {
		this.result = result;
		this.isPartial = true;
		this.refresh();
	}
	refresh() {
		const bg = this.isPartial ? theme.toolPendingBg : this.isError ? theme.toolErrorBg : theme.toolSuccessBg;
		this.box.setBgFn((line) => bg(line));
		const display = resolveToolDisplay({
			name: this.toolName,
			args: this.args
		});
		const title = `${display.emoji} ${display.label}${this.isPartial ? " (running)" : ""}`;
		this.header.setText(theme.toolTitle(theme.bold(title)));
		const argLine = formatArgs(this.toolName, this.args);
		this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));
		const text = extractText(this.result) || (this.isPartial ? "…" : "");
		if (!this.expanded && text) {
			const lines = text.split("\n");
			const preview = lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…` : text;
			this.output.setText(preview);
		} else this.output.setText(text);
	}
};

//#endregion
//#region src/tui/components/markdown-message.ts
var MarkdownMessageComponent = class extends Container {
	constructor(text, y, options) {
		super();
		this.body = new Markdown(text, 1, y, markdownTheme, options);
		this.addChild(new Spacer(1));
		this.addChild(this.body);
	}
	setText(text) {
		this.body.setText(text);
	}
};

//#endregion
//#region src/tui/components/user-message.ts
var UserMessageComponent = class extends MarkdownMessageComponent {
	constructor(text) {
		super(text, 1, {
			bgColor: (line) => theme.userBg(line),
			color: (line) => theme.userText(line)
		});
	}
};

//#endregion
//#region src/tui/components/chat-log.ts
var ChatLog = class extends Container {
	constructor(maxComponents = 180) {
		super();
		this.toolById = /* @__PURE__ */ new Map();
		this.streamingRuns = /* @__PURE__ */ new Map();
		this.toolsExpanded = false;
		this.maxComponents = Math.max(20, Math.floor(maxComponents));
	}
	dropComponentReferences(component) {
		for (const [toolId, tool] of this.toolById.entries()) if (tool === component) this.toolById.delete(toolId);
		for (const [runId, message] of this.streamingRuns.entries()) if (message === component) this.streamingRuns.delete(runId);
	}
	pruneOverflow() {
		while (this.children.length > this.maxComponents) {
			const oldest = this.children[0];
			if (!oldest) return;
			this.removeChild(oldest);
			this.dropComponentReferences(oldest);
		}
	}
	append(component) {
		this.addChild(component);
		this.pruneOverflow();
	}
	clearAll() {
		this.clear();
		this.toolById.clear();
		this.streamingRuns.clear();
	}
	addSystem(text) {
		this.append(new Spacer(1));
		this.append(new Text(theme.system(text), 1, 0));
	}
	addUser(text) {
		this.append(new UserMessageComponent(text));
	}
	resolveRunId(runId) {
		return runId ?? "default";
	}
	startAssistant(text, runId) {
		const component = new AssistantMessageComponent(text);
		this.streamingRuns.set(this.resolveRunId(runId), component);
		this.append(component);
		return component;
	}
	updateAssistant(text, runId) {
		const effectiveRunId = this.resolveRunId(runId);
		const existing = this.streamingRuns.get(effectiveRunId);
		if (!existing) {
			this.startAssistant(text, runId);
			return;
		}
		existing.setText(text);
	}
	finalizeAssistant(text, runId) {
		const effectiveRunId = this.resolveRunId(runId);
		const existing = this.streamingRuns.get(effectiveRunId);
		if (existing) {
			existing.setText(text);
			this.streamingRuns.delete(effectiveRunId);
			return;
		}
		this.append(new AssistantMessageComponent(text));
	}
	dropAssistant(runId) {
		const effectiveRunId = this.resolveRunId(runId);
		const existing = this.streamingRuns.get(effectiveRunId);
		if (!existing) return;
		this.removeChild(existing);
		this.streamingRuns.delete(effectiveRunId);
	}
	startTool(toolCallId, toolName, args) {
		const existing = this.toolById.get(toolCallId);
		if (existing) {
			existing.setArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(toolName, args);
		component.setExpanded(this.toolsExpanded);
		this.toolById.set(toolCallId, component);
		this.append(component);
		return component;
	}
	updateToolArgs(toolCallId, args) {
		const existing = this.toolById.get(toolCallId);
		if (!existing) return;
		existing.setArgs(args);
	}
	updateToolResult(toolCallId, result, opts) {
		const existing = this.toolById.get(toolCallId);
		if (!existing) return;
		if (opts?.partial) {
			existing.setPartialResult(result);
			return;
		}
		existing.setResult(result, { isError: opts?.isError });
	}
	setToolsExpanded(expanded) {
		this.toolsExpanded = expanded;
		for (const tool of this.toolById.values()) tool.setExpanded(expanded);
	}
};

//#endregion
//#region src/tui/components/custom-editor.ts
var CustomEditor = class extends Editor {
	handleInput(data) {
		if (matchesKey(data, Key.alt("enter")) && this.onAltEnter) {
			this.onAltEnter();
			return;
		}
		if (matchesKey(data, Key.ctrl("l")) && this.onCtrlL) {
			this.onCtrlL();
			return;
		}
		if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO) {
			this.onCtrlO();
			return;
		}
		if (matchesKey(data, Key.ctrl("p")) && this.onCtrlP) {
			this.onCtrlP();
			return;
		}
		if (matchesKey(data, Key.ctrl("g")) && this.onCtrlG) {
			this.onCtrlG();
			return;
		}
		if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
			this.onCtrlT();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) && this.onShiftTab) {
			this.onShiftTab();
			return;
		}
		if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
			this.onEscape();
			return;
		}
		if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
			this.onCtrlC();
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			if (this.getText().length === 0 && this.onCtrlD) this.onCtrlD();
			return;
		}
		super.handleInput(data);
	}
};

//#endregion
//#region src/tui/gateway-chat.ts
var GatewayChatClient = class {
	constructor(opts) {
		const resolved = resolveGatewayConnection(opts);
		this.connection = resolved;
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
		this.client = new GatewayClient({
			url: resolved.url,
			token: resolved.token,
			password: resolved.password,
			clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
			clientDisplayName: "openclaw-tui",
			clientVersion: VERSION,
			platform: process.platform,
			mode: GATEWAY_CLIENT_MODES.UI,
			caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
			instanceId: randomUUID(),
			minProtocol: PROTOCOL_VERSION,
			maxProtocol: PROTOCOL_VERSION,
			onHelloOk: (hello) => {
				this.hello = hello;
				this.resolveReady?.();
				this.onConnected?.();
			},
			onEvent: (evt) => {
				this.onEvent?.({
					event: evt.event,
					payload: evt.payload,
					seq: evt.seq
				});
			},
			onClose: (_code, reason) => {
				this.readyPromise = new Promise((resolve) => {
					this.resolveReady = resolve;
				});
				this.onDisconnected?.(reason);
			},
			onGap: (info) => {
				this.onGap?.(info);
			}
		});
	}
	start() {
		this.client.start();
	}
	stop() {
		this.client.stop();
	}
	async waitForReady() {
		await this.readyPromise;
	}
	async sendChat(opts) {
		const runId = opts.runId ?? randomUUID();
		await this.client.request("chat.send", {
			sessionKey: opts.sessionKey,
			message: opts.message,
			thinking: opts.thinking,
			deliver: opts.deliver,
			timeoutMs: opts.timeoutMs,
			idempotencyKey: runId
		});
		return { runId };
	}
	async abortChat(opts) {
		return await this.client.request("chat.abort", {
			sessionKey: opts.sessionKey,
			runId: opts.runId
		});
	}
	async loadHistory(opts) {
		return await this.client.request("chat.history", {
			sessionKey: opts.sessionKey,
			limit: opts.limit
		});
	}
	async listSessions(opts) {
		return await this.client.request("sessions.list", {
			limit: opts?.limit,
			activeMinutes: opts?.activeMinutes,
			includeGlobal: opts?.includeGlobal,
			includeUnknown: opts?.includeUnknown,
			includeDerivedTitles: opts?.includeDerivedTitles,
			includeLastMessage: opts?.includeLastMessage,
			agentId: opts?.agentId
		});
	}
	async listAgents() {
		return await this.client.request("agents.list", {});
	}
	async patchSession(opts) {
		return await this.client.request("sessions.patch", opts);
	}
	async resetSession(key, reason) {
		return await this.client.request("sessions.reset", {
			key,
			...reason ? { reason } : {}
		});
	}
	async getStatus() {
		return await this.client.request("status");
	}
	async listModels() {
		const res = await this.client.request("models.list");
		return Array.isArray(res?.models) ? res.models : [];
	}
};
function resolveGatewayConnection(opts) {
	const config = loadConfig();
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	const authToken = config.gateway?.auth?.token;
	const urlOverride = typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : void 0;
	const explicitAuth = resolveExplicitGatewayAuth({
		token: opts.token,
		password: opts.password
	});
	ensureExplicitGatewayAuth({
		urlOverride,
		auth: explicitAuth,
		errorHint: "Fix: pass --token or --password when using --url."
	});
	return {
		url: buildGatewayConnectionDetails({
			config,
			...urlOverride ? { url: urlOverride } : {}
		}).url,
		token: explicitAuth.token || (!urlOverride ? isRemoteMode ? typeof remote?.token === "string" && remote.token.trim().length > 0 ? remote.token.trim() : void 0 : process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || (typeof authToken === "string" && authToken.trim().length > 0 ? authToken.trim() : void 0) : void 0),
		password: explicitAuth.password || (!urlOverride ? process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || (typeof remote?.password === "string" && remote.password.trim().length > 0 ? remote.password.trim() : void 0) : void 0)
	};
}

//#endregion
//#region src/tui/components/fuzzy-filter.ts
/**
* Shared fuzzy filtering utilities for select list components.
*/
/**
* Word boundary characters for matching.
*/
const WORD_BOUNDARY_CHARS = /[\s\-_./:#@]/;
/**
* Check if position is at a word boundary.
*/
function isWordBoundary(text, index) {
	return index === 0 || WORD_BOUNDARY_CHARS.test(text[index - 1] ?? "");
}
/**
* Find index where query matches at a word boundary in text.
* Returns null if no match.
*/
function findWordBoundaryIndex(text, query) {
	if (!query) return null;
	const textLower = text.toLowerCase();
	const queryLower = query.toLowerCase();
	const maxIndex = textLower.length - queryLower.length;
	if (maxIndex < 0) return null;
	for (let i = 0; i <= maxIndex; i++) if (textLower.startsWith(queryLower, i) && isWordBoundary(textLower, i)) return i;
	return null;
}
/**
* Fuzzy match with pre-lowercased inputs (avoids toLowerCase on every keystroke).
* Returns score (lower = better) or null if no match.
*/
function fuzzyMatchLower(queryLower, textLower) {
	if (queryLower.length === 0) return 0;
	if (queryLower.length > textLower.length) return null;
	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;
	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) if (textLower[i] === queryLower[queryIndex]) {
		const isAtWordBoundary = isWordBoundary(textLower, i);
		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
		}
		if (isAtWordBoundary) score -= 10;
		score += i * .1;
		lastMatchIndex = i;
		queryIndex++;
	}
	return queryIndex < queryLower.length ? null : score;
}
/**
* Filter items using pre-lowercased searchTextLower field.
* Supports space-separated tokens (all must match).
*/
function fuzzyFilterLower(items, queryLower) {
	const trimmed = queryLower.trim();
	if (!trimmed) return items;
	const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return items;
	const results = [];
	for (const item of items) {
		const text = item.searchTextLower ?? "";
		let totalScore = 0;
		let allMatch = true;
		for (const token of tokens) {
			const score = fuzzyMatchLower(token, text);
			if (score !== null) totalScore += score;
			else {
				allMatch = false;
				break;
			}
		}
		if (allMatch) results.push({
			item,
			score: totalScore
		});
	}
	results.sort((a, b) => a.score - b.score);
	return results.map((r) => r.item);
}
/**
* Prepare items for fuzzy filtering by pre-computing lowercase search text.
*/
function prepareSearchItems(items) {
	return items.map((item) => {
		const parts = [];
		if (item.label) parts.push(item.label);
		if (item.description) parts.push(item.description);
		if (item.searchText) parts.push(item.searchText);
		return {
			...item,
			searchTextLower: parts.join(" ").toLowerCase()
		};
	});
}

//#endregion
//#region src/tui/components/filterable-select-list.ts
/**
* Combines text input filtering with a select list.
* User types to filter, arrows/j/k to navigate, Enter to select, Escape to clear/cancel.
*/
var FilterableSelectList = class {
	constructor(items, maxVisible, theme) {
		this.filterText = "";
		this.allItems = prepareSearchItems(items);
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.input = new Input();
		this.selectList = new SelectList(this.allItems, maxVisible, theme);
	}
	applyFilter() {
		const queryLower = this.filterText.toLowerCase();
		if (!queryLower.trim()) {
			this.selectList = new SelectList(this.allItems, this.maxVisible, this.theme);
			return;
		}
		this.selectList = new SelectList(fuzzyFilterLower(this.allItems, queryLower), this.maxVisible, this.theme);
	}
	invalidate() {
		this.input.invalidate();
		this.selectList.invalidate();
	}
	render(width) {
		const lines = [];
		const filterLabel = this.theme.filterLabel("Filter: ");
		const inputText = this.input.render(width - 8)[0] ?? "";
		lines.push(filterLabel + inputText);
		lines.push(chalk.dim("─".repeat(Math.max(0, width))));
		const listLines = this.selectList.render(width);
		lines.push(...listLines);
		return lines;
	}
	handleInput(keyData) {
		const allowVimNav = !this.filterText.trim();
		if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p") || allowVimNav && keyData === "k") {
			this.selectList.handleInput("\x1B[A");
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n") || allowVimNav && keyData === "j") {
			this.selectList.handleInput("\x1B[B");
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.onSelect?.(selected);
			return;
		}
		if (getEditorKeybindings().matches(keyData, "selectCancel")) {
			if (this.filterText) {
				this.filterText = "";
				this.input.setValue("");
				this.applyFilter();
			} else this.onCancel?.();
			return;
		}
		const prevValue = this.input.getValue();
		this.input.handleInput(keyData);
		const newValue = this.input.getValue();
		if (newValue !== prevValue) {
			this.filterText = newValue;
			this.applyFilter();
		}
	}
	getSelectedItem() {
		return this.selectList.getSelectedItem();
	}
	getFilterText() {
		return this.filterText;
	}
};

//#endregion
//#region src/tui/components/searchable-select-list.ts
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_SGR_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
/**
* A select list with a search input at the top for fuzzy filtering.
*/
var SearchableSelectList = class SearchableSelectList {
	static {
		this.DESCRIPTION_LAYOUT_MIN_WIDTH = 40;
	}
	static {
		this.DESCRIPTION_MIN_WIDTH = 12;
	}
	static {
		this.DESCRIPTION_SPACING_WIDTH = 2;
	}
	static {
		this.RIGHT_MARGIN_WIDTH = 2;
	}
	constructor(items, maxVisible, theme) {
		this.selectedIndex = 0;
		this.regexCache = /* @__PURE__ */ new Map();
		this.compareByScore = (a, b) => {
			if (a.tier !== b.tier) return a.tier - b.tier;
			if (a.score !== b.score) return a.score - b.score;
			return this.getItemLabel(a.item).localeCompare(this.getItemLabel(b.item));
		};
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.searchInput = new Input();
	}
	getCachedRegex(pattern) {
		let regex = this.regexCache.get(pattern);
		if (!regex) {
			regex = new RegExp(this.escapeRegex(pattern), "gi");
			this.regexCache.set(pattern, regex);
		}
		return regex;
	}
	updateFilter() {
		const query = this.searchInput.getValue().trim();
		if (!query) this.filteredItems = this.items;
		else this.filteredItems = this.smartFilter(query);
		this.selectedIndex = 0;
		this.notifySelectionChange();
	}
	/**
	* Smart filtering that prioritizes:
	* 1. Exact substring match in label (highest priority)
	* 2. Word-boundary prefix match in label
	* 3. Exact substring in description
	* 4. Fuzzy match (lowest priority)
	*/
	smartFilter(query) {
		const q = query.toLowerCase();
		const scoredItems = [];
		const fuzzyCandidates = [];
		for (const item of this.items) {
			const rawLabel = this.getItemLabel(item);
			const rawDesc = item.description ?? "";
			const label = stripAnsi$1(rawLabel).toLowerCase();
			const desc = stripAnsi$1(rawDesc).toLowerCase();
			const labelIndex = label.indexOf(q);
			if (labelIndex !== -1) {
				scoredItems.push({
					item,
					tier: 0,
					score: labelIndex
				});
				continue;
			}
			const wordBoundaryIndex = findWordBoundaryIndex(label, q);
			if (wordBoundaryIndex !== null) {
				scoredItems.push({
					item,
					tier: 1,
					score: wordBoundaryIndex
				});
				continue;
			}
			const descIndex = desc.indexOf(q);
			if (descIndex !== -1) {
				scoredItems.push({
					item,
					tier: 2,
					score: descIndex
				});
				continue;
			}
			const searchText = item.searchText ?? "";
			fuzzyCandidates.push({
				item,
				searchTextLower: [
					rawLabel,
					rawDesc,
					searchText
				].map((value) => stripAnsi$1(value)).filter(Boolean).join(" ").toLowerCase()
			});
		}
		scoredItems.sort(this.compareByScore);
		const fuzzyMatches = fuzzyFilterLower(fuzzyCandidates, q);
		return [...scoredItems.map((s) => s.item), ...fuzzyMatches.map((entry) => entry.item)];
	}
	escapeRegex(str) {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	getItemLabel(item) {
		return item.label || item.value;
	}
	splitAnsiParts(text) {
		const parts = [];
		ANSI_SGR_REGEX.lastIndex = 0;
		let lastIndex = 0;
		let match;
		while ((match = ANSI_SGR_REGEX.exec(text)) !== null) {
			if (match.index > lastIndex) parts.push({
				text: text.slice(lastIndex, match.index),
				isAnsi: false
			});
			parts.push({
				text: match[0],
				isAnsi: true
			});
			lastIndex = match.index + match[0].length;
		}
		if (lastIndex < text.length) parts.push({
			text: text.slice(lastIndex),
			isAnsi: false
		});
		return parts;
	}
	highlightMatch(text, query) {
		const tokens = query.trim().split(/\s+/).map((token) => token.toLowerCase()).filter((token) => token.length > 0);
		if (tokens.length === 0) return text;
		const uniqueTokens = Array.from(new Set(tokens)).toSorted((a, b) => b.length - a.length);
		let parts = this.splitAnsiParts(text);
		for (const token of uniqueTokens) {
			const regex = this.getCachedRegex(token);
			const nextParts = [];
			for (const part of parts) {
				if (part.isAnsi) {
					nextParts.push(part);
					continue;
				}
				regex.lastIndex = 0;
				const replaced = part.text.replace(regex, (match) => this.theme.matchHighlight(match));
				if (replaced === part.text) {
					nextParts.push(part);
					continue;
				}
				nextParts.push(...this.splitAnsiParts(replaced));
			}
			parts = nextParts;
		}
		return parts.map((part) => part.text).join("");
	}
	setSelectedIndex(index) {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}
	invalidate() {
		this.searchInput.invalidate();
	}
	render(width) {
		const lines = [];
		const prompt = this.theme.searchPrompt("search: ");
		const inputWidth = Math.max(1, width - visibleWidth(prompt));
		const inputText = this.searchInput.render(inputWidth)[0] ?? "";
		lines.push(`${prompt}${this.theme.searchInput(inputText)}`);
		lines.push("");
		const query = this.searchInput.getValue().trim();
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matches"));
			return lines;
		}
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			lines.push(this.renderItemLine(item, isSelected, width, query));
		}
		if (this.filteredItems.length > this.maxVisible) {
			const scrollInfo = `${this.selectedIndex + 1}/${this.filteredItems.length}`;
			lines.push(this.theme.scrollInfo(`  ${scrollInfo}`));
		}
		return lines;
	}
	renderItemLine(item, isSelected, width, query) {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = prefix.length;
		const displayValue = this.getItemLabel(item);
		const description = item.description;
		if (description) {
			const descriptionLayout = this.getDescriptionLayout(width, prefixWidth);
			if (descriptionLayout) {
				const truncatedValue = truncateToWidth(displayValue, descriptionLayout.maxValueWidth, "");
				const valueText = this.highlightMatch(truncatedValue, query);
				const usedByValue = visibleWidth(valueText);
				const descriptionWidth = descriptionLayout.availableWidth - usedByValue - descriptionLayout.spacingWidth;
				if (descriptionWidth >= SearchableSelectList.DESCRIPTION_MIN_WIDTH) {
					const spacing = " ".repeat(descriptionLayout.spacingWidth);
					const truncatedDesc = truncateToWidth(description, descriptionWidth, "");
					const highlightedDesc = this.highlightMatch(truncatedDesc, query);
					const line = `${prefix}${valueText}${spacing}${isSelected ? highlightedDesc : this.theme.description(highlightedDesc)}`;
					return isSelected ? this.theme.selectedText(line) : line;
				}
			}
		}
		const truncatedValue = truncateToWidth(displayValue, width - prefixWidth - 2, "");
		const line = `${prefix}${this.highlightMatch(truncatedValue, query)}`;
		return isSelected ? this.theme.selectedText(line) : line;
	}
	getDescriptionLayout(width, prefixWidth) {
		if (width <= SearchableSelectList.DESCRIPTION_LAYOUT_MIN_WIDTH) return null;
		const availableWidth = Math.max(1, width - prefixWidth - SearchableSelectList.RIGHT_MARGIN_WIDTH);
		const maxValueWidth = availableWidth - SearchableSelectList.DESCRIPTION_MIN_WIDTH - SearchableSelectList.DESCRIPTION_SPACING_WIDTH;
		if (maxValueWidth < 1) return null;
		return {
			availableWidth,
			maxValueWidth,
			spacingWidth: SearchableSelectList.DESCRIPTION_SPACING_WIDTH
		};
	}
	handleInput(keyData) {
		if (isKeyRelease(keyData)) return;
		const allowVimNav = !this.searchInput.getValue().trim();
		if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p") || allowVimNav && keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.notifySelectionChange();
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n") || allowVimNav && keyData === "j") {
			this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
			this.notifySelectionChange();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item && this.onSelect) this.onSelect(item);
			return;
		}
		if (getEditorKeybindings().matches(keyData, "selectCancel")) {
			if (this.onCancel) this.onCancel();
			return;
		}
		const prevValue = this.searchInput.getValue();
		this.searchInput.handleInput(keyData);
		if (prevValue !== this.searchInput.getValue()) this.updateFilter();
	}
	notifySelectionChange() {
		const item = this.filteredItems[this.selectedIndex];
		if (item && this.onSelectionChange) this.onSelectionChange(item);
	}
	getSelectedItem() {
		return this.filteredItems[this.selectedIndex] ?? null;
	}
};

//#endregion
//#region src/tui/components/selectors.ts
function createSearchableSelectList(items, maxVisible = 7) {
	return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}
function createFilterableSelectList(items, maxVisible = 7) {
	return new FilterableSelectList(items, maxVisible, filterableSelectListTheme);
}
function createSettingsList(items, onChange, onCancel, maxVisible = 7) {
	return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}

//#endregion
//#region src/tui/tui-status-summary.ts
function formatStatusSummary(summary) {
	const lines = [];
	lines.push("Gateway status");
	if (!summary.linkChannel) lines.push("Link channel: unknown");
	else {
		const linkLabel = summary.linkChannel.label ?? "Link channel";
		const linked = summary.linkChannel.linked === true;
		const authAge = linked && typeof summary.linkChannel.authAgeMs === "number" ? ` (last refreshed ${formatTimeAgo(summary.linkChannel.authAgeMs)})` : "";
		lines.push(`${linkLabel}: ${linked ? "linked" : "not linked"}${authAge}`);
	}
	const providerSummary = Array.isArray(summary.providerSummary) ? summary.providerSummary : [];
	if (providerSummary.length > 0) {
		lines.push("");
		lines.push("System:");
		for (const line of providerSummary) lines.push(`  ${line}`);
	}
	const heartbeatAgents = summary.heartbeat?.agents ?? [];
	if (heartbeatAgents.length > 0) {
		const heartbeatParts = heartbeatAgents.map((agent) => {
			const agentId = agent.agentId ?? "unknown";
			if (!agent.enabled || !agent.everyMs) return `disabled (${agentId})`;
			return `${agent.every ?? "unknown"} (${agentId})`;
		});
		lines.push("");
		lines.push(`Heartbeat: ${heartbeatParts.join(", ")}`);
	}
	const sessionPaths = summary.sessions?.paths ?? [];
	if (sessionPaths.length === 1) lines.push(`Session store: ${sessionPaths[0]}`);
	else if (sessionPaths.length > 1) lines.push(`Session stores: ${sessionPaths.length}`);
	const defaults = summary.sessions?.defaults;
	const defaultModel = defaults?.model ?? "unknown";
	const defaultCtx = typeof defaults?.contextTokens === "number" ? ` (${formatTokenCount(defaults.contextTokens)} ctx)` : "";
	lines.push(`Default model: ${defaultModel}${defaultCtx}`);
	const sessionCount = summary.sessions?.count ?? 0;
	lines.push(`Active sessions: ${sessionCount}`);
	const recent = Array.isArray(summary.sessions?.recent) ? summary.sessions?.recent : [];
	if (recent.length > 0) {
		lines.push("Recent sessions:");
		for (const entry of recent) {
			const ageLabel = typeof entry.age === "number" ? formatTimeAgo(entry.age) : "no activity";
			const model = entry.model ?? "unknown";
			const usage = formatContextUsageLine({
				total: entry.totalTokens ?? null,
				context: entry.contextTokens ?? null,
				remaining: entry.remainingTokens ?? null,
				percent: entry.percentUsed ?? null
			});
			const flags = entry.flags?.length ? ` | flags: ${entry.flags.join(", ")}` : "";
			lines.push(`- ${entry.key}${entry.kind ? ` [${entry.kind}]` : ""} | ${ageLabel} | model ${model} | ${usage}${flags}`);
		}
	}
	const queued = Array.isArray(summary.queuedSystemEvents) ? summary.queuedSystemEvents : [];
	if (queued.length > 0) {
		const preview = queued.slice(0, 3).join(" | ");
		lines.push(`Queued system events (${queued.length}): ${preview}`);
	}
	return lines;
}

//#endregion
//#region src/tui/tui-command-handlers.ts
function createCommandHandlers(context) {
	const { client, chatLog, tui, opts, state, deliverDefault, openOverlay, closeOverlay, refreshSessionInfo, loadHistory, setSession, refreshAgents, abortActive, setActivityStatus, formatSessionKey, applySessionInfoFromPatch, noteLocalRunId, forgetLocalRunId, requestExit } = context;
	const setAgent = async (id) => {
		state.currentAgentId = normalizeAgentId(id);
		await setSession("");
	};
	const closeOverlayAndRender = () => {
		closeOverlay();
		tui.requestRender();
	};
	const openSelector = (selector, onSelect) => {
		selector.onSelect = (item) => {
			(async () => {
				await onSelect(item.value);
				closeOverlayAndRender();
			})();
		};
		selector.onCancel = closeOverlayAndRender;
		openOverlay(selector);
		tui.requestRender();
	};
	const openModelSelector = async () => {
		try {
			const models = await client.listModels();
			if (models.length === 0) {
				chatLog.addSystem("no models available");
				tui.requestRender();
				return;
			}
			openSelector(createSearchableSelectList(models.map((model) => ({
				value: `${model.provider}/${model.id}`,
				label: `${model.provider}/${model.id}`,
				description: model.name && model.name !== model.id ? model.name : ""
			})), 9), async (value) => {
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						model: value
					});
					chatLog.addSystem(`model set to ${value}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`model set failed: ${String(err)}`);
				}
			});
		} catch (err) {
			chatLog.addSystem(`model list failed: ${String(err)}`);
			tui.requestRender();
		}
	};
	const openAgentSelector = async () => {
		await refreshAgents();
		if (state.agents.length === 0) {
			chatLog.addSystem("no agents found");
			tui.requestRender();
			return;
		}
		openSelector(createSearchableSelectList(state.agents.map((agent) => ({
			value: agent.id,
			label: agent.name ? `${agent.id} (${agent.name})` : agent.id,
			description: agent.id === state.agentDefaultId ? "default" : ""
		})), 9), async (value) => {
			await setAgent(value);
		});
	};
	const openSessionSelector = async () => {
		try {
			openSelector(createFilterableSelectList((await client.listSessions({
				includeGlobal: false,
				includeUnknown: false,
				includeDerivedTitles: true,
				includeLastMessage: true,
				agentId: state.currentAgentId
			})).sessions.map((session) => {
				const title = session.derivedTitle ?? session.displayName;
				const formattedKey = formatSessionKey(session.key);
				const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
				const timePart = session.updatedAt ? formatRelativeTimestamp(session.updatedAt, {
					dateFallback: true,
					fallback: ""
				}) : "";
				const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
				const description = timePart && preview ? `${timePart} · ${preview}` : preview ?? timePart;
				return {
					value: session.key,
					label,
					description,
					searchText: [
						session.displayName,
						session.label,
						session.subject,
						session.sessionId,
						session.key,
						session.lastMessagePreview
					].filter(Boolean).join(" ")
				};
			}), 9), async (value) => {
				await setSession(value);
			});
		} catch (err) {
			chatLog.addSystem(`sessions list failed: ${String(err)}`);
			tui.requestRender();
		}
	};
	const openSettings = () => {
		openOverlay(createSettingsList([{
			id: "tools",
			label: "Tool output",
			currentValue: state.toolsExpanded ? "expanded" : "collapsed",
			values: ["collapsed", "expanded"]
		}, {
			id: "thinking",
			label: "Show thinking",
			currentValue: state.showThinking ? "on" : "off",
			values: ["off", "on"]
		}], (id, value) => {
			if (id === "tools") {
				state.toolsExpanded = value === "expanded";
				chatLog.setToolsExpanded(state.toolsExpanded);
			}
			if (id === "thinking") {
				state.showThinking = value === "on";
				loadHistory();
			}
			tui.requestRender();
		}, () => {
			closeOverlay();
			tui.requestRender();
		}));
		tui.requestRender();
	};
	const handleCommand = async (raw) => {
		const { name, args } = parseCommand(raw);
		if (!name) return;
		switch (name) {
			case "help":
				chatLog.addSystem(helpText({
					provider: state.sessionInfo.modelProvider,
					model: state.sessionInfo.model
				}));
				break;
			case "status":
				try {
					const status = await client.getStatus();
					if (typeof status === "string") {
						chatLog.addSystem(status);
						break;
					}
					if (status && typeof status === "object") {
						const lines = formatStatusSummary(status);
						for (const line of lines) chatLog.addSystem(line);
						break;
					}
					chatLog.addSystem("status: unknown response");
				} catch (err) {
					chatLog.addSystem(`status failed: ${String(err)}`);
				}
				break;
			case "agent":
				if (!args) await openAgentSelector();
				else await setAgent(args);
				break;
			case "agents":
				await openAgentSelector();
				break;
			case "session":
				if (!args) await openSessionSelector();
				else await setSession(args);
				break;
			case "sessions":
				await openSessionSelector();
				break;
			case "model":
				if (!args) await openModelSelector();
				else try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						model: args
					});
					chatLog.addSystem(`model set to ${args}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`model set failed: ${String(err)}`);
				}
				break;
			case "models":
				await openModelSelector();
				break;
			case "think":
				if (!args) {
					const levels = formatThinkingLevels(state.sessionInfo.modelProvider, state.sessionInfo.model, "|");
					chatLog.addSystem(`usage: /think <${levels}>`);
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						thinkingLevel: args
					});
					chatLog.addSystem(`thinking set to ${args}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`think failed: ${String(err)}`);
				}
				break;
			case "verbose":
				if (!args) {
					chatLog.addSystem("usage: /verbose <on|off>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						verboseLevel: args
					});
					chatLog.addSystem(`verbose set to ${args}`);
					applySessionInfoFromPatch(result);
					await loadHistory();
				} catch (err) {
					chatLog.addSystem(`verbose failed: ${String(err)}`);
				}
				break;
			case "reasoning":
				if (!args) {
					chatLog.addSystem("usage: /reasoning <on|off>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						reasoningLevel: args
					});
					chatLog.addSystem(`reasoning set to ${args}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`reasoning failed: ${String(err)}`);
				}
				break;
			case "usage": {
				const normalized = args ? normalizeUsageDisplay(args) : void 0;
				if (args && !normalized) {
					chatLog.addSystem("usage: /usage <off|tokens|full>");
					break;
				}
				const currentRaw = state.sessionInfo.responseUsage;
				const current = resolveResponseUsageMode(currentRaw);
				const next = normalized ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						responseUsage: next === "off" ? null : next
					});
					chatLog.addSystem(`usage footer: ${next}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`usage failed: ${String(err)}`);
				}
				break;
			}
			case "elevated":
				if (!args) {
					chatLog.addSystem("usage: /elevated <on|off|ask|full>");
					break;
				}
				if (![
					"on",
					"off",
					"ask",
					"full"
				].includes(args)) {
					chatLog.addSystem("usage: /elevated <on|off|ask|full>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						elevatedLevel: args
					});
					chatLog.addSystem(`elevated set to ${args}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`elevated failed: ${String(err)}`);
				}
				break;
			case "activation":
				if (!args) {
					chatLog.addSystem("usage: /activation <mention|always>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						groupActivation: args === "always" ? "always" : "mention"
					});
					chatLog.addSystem(`activation set to ${args}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`activation failed: ${String(err)}`);
				}
				break;
			case "new":
			case "reset":
				try {
					state.sessionInfo.inputTokens = null;
					state.sessionInfo.outputTokens = null;
					state.sessionInfo.totalTokens = null;
					tui.requestRender();
					await client.resetSession(state.currentSessionKey, name);
					chatLog.addSystem(`session ${state.currentSessionKey} reset`);
					await loadHistory();
				} catch (err) {
					chatLog.addSystem(`reset failed: ${String(err)}`);
				}
				break;
			case "abort":
				await abortActive();
				break;
			case "settings":
				openSettings();
				break;
			case "exit":
			case "quit":
				requestExit();
				break;
			default:
				await sendMessage(raw);
				break;
		}
		tui.requestRender();
	};
	const sendMessage = async (text) => {
		if (!state.isConnected) {
			chatLog.addSystem("not connected to gateway — message not sent");
			setActivityStatus("disconnected");
			tui.requestRender();
			return;
		}
		try {
			chatLog.addUser(text);
			tui.requestRender();
			const runId = randomUUID();
			noteLocalRunId(runId);
			state.activeChatRunId = runId;
			setActivityStatus("sending");
			tui.requestRender();
			await client.sendChat({
				sessionKey: state.currentSessionKey,
				message: text,
				thinking: opts.thinking,
				deliver: deliverDefault,
				timeoutMs: opts.timeoutMs,
				runId
			});
			setActivityStatus("waiting");
			tui.requestRender();
		} catch (err) {
			if (state.activeChatRunId) forgetLocalRunId?.(state.activeChatRunId);
			state.activeChatRunId = null;
			chatLog.addSystem(`send failed: ${String(err)}`);
			setActivityStatus("error");
			tui.requestRender();
		}
	};
	return {
		handleCommand,
		sendMessage,
		openModelSelector,
		openAgentSelector,
		openSessionSelector,
		openSettings,
		setAgent
	};
}

//#endregion
//#region src/tui/tui-stream-assembler.ts
function extractTextBlocksAndSignals(message) {
	if (!message || typeof message !== "object") return {
		textBlocks: [],
		sawNonTextContentBlocks: false
	};
	const content = message.content;
	if (typeof content === "string") {
		const text = content.trim();
		return {
			textBlocks: text ? [text] : [],
			sawNonTextContentBlocks: false
		};
	}
	if (!Array.isArray(content)) return {
		textBlocks: [],
		sawNonTextContentBlocks: false
	};
	const textBlocks = [];
	let sawNonTextContentBlocks = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block;
		if (rec.type === "text" && typeof rec.text === "string") {
			const text = rec.text.trim();
			if (text) textBlocks.push(text);
			continue;
		}
		if (typeof rec.type === "string" && rec.type !== "thinking") sawNonTextContentBlocks = true;
	}
	return {
		textBlocks,
		sawNonTextContentBlocks
	};
}
function isDroppedBoundaryTextBlockSubset(params) {
	const { streamedTextBlocks, finalTextBlocks } = params;
	if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) return false;
	if (finalTextBlocks.every((block, index) => streamedTextBlocks[index] === block)) return true;
	const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
	return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
}
function shouldPreserveBoundaryDroppedText(params) {
	if (params.boundaryDropMode === "off") return false;
	if (!(params.boundaryDropMode === "streamed-or-incoming" ? params.streamedSawNonTextContentBlocks || params.incomingSawNonTextContentBlocks : params.streamedSawNonTextContentBlocks)) return false;
	return isDroppedBoundaryTextBlockSubset({
		streamedTextBlocks: params.streamedTextBlocks,
		finalTextBlocks: params.nextContentBlocks
	});
}
var TuiStreamAssembler = class {
	constructor() {
		this.runs = /* @__PURE__ */ new Map();
	}
	getOrCreateRun(runId) {
		let state = this.runs.get(runId);
		if (!state) {
			state = {
				thinkingText: "",
				contentText: "",
				contentBlocks: [],
				sawNonTextContentBlocks: false,
				displayText: ""
			};
			this.runs.set(runId, state);
		}
		return state;
	}
	updateRunState(state, message, showThinking, opts) {
		const thinkingText = extractThinkingFromMessage(message);
		const contentText = extractContentFromMessage(message);
		const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);
		if (thinkingText) state.thinkingText = thinkingText;
		if (contentText) {
			const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
			if (!shouldPreserveBoundaryDroppedText({
				boundaryDropMode: opts?.boundaryDropMode ?? "off",
				streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
				incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
				streamedTextBlocks: state.contentBlocks,
				nextContentBlocks
			})) {
				state.contentText = contentText;
				state.contentBlocks = nextContentBlocks;
			}
		}
		if (sawNonTextContentBlocks) state.sawNonTextContentBlocks = true;
		state.displayText = composeThinkingAndContent({
			thinkingText: state.thinkingText,
			contentText: state.contentText,
			showThinking
		});
	}
	ingestDelta(runId, message, showThinking) {
		const state = this.getOrCreateRun(runId);
		const previousDisplayText = state.displayText;
		this.updateRunState(state, message, showThinking, { boundaryDropMode: "streamed-or-incoming" });
		if (!state.displayText || state.displayText === previousDisplayText) return null;
		return state.displayText;
	}
	finalize(runId, message, showThinking) {
		const state = this.getOrCreateRun(runId);
		const streamedDisplayText = state.displayText;
		const streamedTextBlocks = [...state.contentBlocks];
		const streamedSawNonTextContentBlocks = state.sawNonTextContentBlocks;
		this.updateRunState(state, message, showThinking, { boundaryDropMode: "streamed-only" });
		const finalComposed = state.displayText;
		const finalText = resolveFinalAssistantText({
			finalText: streamedSawNonTextContentBlocks && isDroppedBoundaryTextBlockSubset({
				streamedTextBlocks,
				finalTextBlocks: state.contentBlocks
			}) ? streamedDisplayText : finalComposed,
			streamedText: streamedDisplayText
		});
		this.runs.delete(runId);
		return finalText;
	}
	drop(runId) {
		this.runs.delete(runId);
	}
};

//#endregion
//#region src/tui/tui-event-handlers.ts
function createEventHandlers(context) {
	const { chatLog, tui, state, setActivityStatus, refreshSessionInfo, loadHistory, isLocalRunId, forgetLocalRunId, clearLocalRunIds } = context;
	const finalizedRuns = /* @__PURE__ */ new Map();
	const sessionRuns = /* @__PURE__ */ new Map();
	let streamAssembler = new TuiStreamAssembler();
	let lastSessionKey = state.currentSessionKey;
	const pruneRunMap = (runs) => {
		if (runs.size <= 200) return;
		const keepUntil = Date.now() - 600 * 1e3;
		for (const [key, ts] of runs) {
			if (runs.size <= 150) break;
			if (ts < keepUntil) runs.delete(key);
		}
		if (runs.size > 200) for (const key of runs.keys()) {
			runs.delete(key);
			if (runs.size <= 150) break;
		}
	};
	const syncSessionKey = () => {
		if (state.currentSessionKey === lastSessionKey) return;
		lastSessionKey = state.currentSessionKey;
		finalizedRuns.clear();
		sessionRuns.clear();
		streamAssembler = new TuiStreamAssembler();
		clearLocalRunIds?.();
	};
	const noteSessionRun = (runId) => {
		sessionRuns.set(runId, Date.now());
		pruneRunMap(sessionRuns);
	};
	const noteFinalizedRun = (runId) => {
		finalizedRuns.set(runId, Date.now());
		sessionRuns.delete(runId);
		streamAssembler.drop(runId);
		pruneRunMap(finalizedRuns);
	};
	const clearActiveRunIfMatch = (runId) => {
		if (state.activeChatRunId === runId) state.activeChatRunId = null;
	};
	const finalizeRun = (params) => {
		noteFinalizedRun(params.runId);
		clearActiveRunIfMatch(params.runId);
		if (params.wasActiveRun) setActivityStatus(params.status);
		refreshSessionInfo?.();
	};
	const terminateRun = (params) => {
		streamAssembler.drop(params.runId);
		sessionRuns.delete(params.runId);
		clearActiveRunIfMatch(params.runId);
		if (params.wasActiveRun) setActivityStatus(params.status);
		refreshSessionInfo?.();
	};
	const hasConcurrentActiveRun = (runId) => {
		const activeRunId = state.activeChatRunId;
		if (!activeRunId || activeRunId === runId) return false;
		return sessionRuns.has(activeRunId);
	};
	const maybeRefreshHistoryForRun = (runId) => {
		if (isLocalRunId?.(runId)) {
			forgetLocalRunId?.(runId);
			return;
		}
		if (hasConcurrentActiveRun(runId)) return;
		loadHistory?.();
	};
	const handleChatEvent = (payload) => {
		if (!payload || typeof payload !== "object") return;
		const evt = payload;
		syncSessionKey();
		if (evt.sessionKey !== state.currentSessionKey) return;
		if (finalizedRuns.has(evt.runId)) {
			if (evt.state === "delta") return;
			if (evt.state === "final") return;
		}
		noteSessionRun(evt.runId);
		if (!state.activeChatRunId) state.activeChatRunId = evt.runId;
		if (evt.state === "delta") {
			const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
			if (!displayText) return;
			chatLog.updateAssistant(displayText, evt.runId);
			setActivityStatus("streaming");
		}
		if (evt.state === "final") {
			const wasActiveRun = state.activeChatRunId === evt.runId;
			if (!evt.message) {
				maybeRefreshHistoryForRun(evt.runId);
				chatLog.dropAssistant(evt.runId);
				finalizeRun({
					runId: evt.runId,
					wasActiveRun,
					status: "idle"
				});
				tui.requestRender();
				return;
			}
			if (isCommandMessage(evt.message)) {
				maybeRefreshHistoryForRun(evt.runId);
				const text = extractTextFromMessage(evt.message);
				if (text) chatLog.addSystem(text);
				finalizeRun({
					runId: evt.runId,
					wasActiveRun,
					status: "idle"
				});
				tui.requestRender();
				return;
			}
			maybeRefreshHistoryForRun(evt.runId);
			const stopReason = evt.message && typeof evt.message === "object" && !Array.isArray(evt.message) ? typeof evt.message.stopReason === "string" ? evt.message.stopReason : "" : "";
			const finalText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking);
			if (finalText === "(no output)" && !isLocalRunId?.(evt.runId)) chatLog.dropAssistant(evt.runId);
			else chatLog.finalizeAssistant(finalText, evt.runId);
			finalizeRun({
				runId: evt.runId,
				wasActiveRun,
				status: stopReason === "error" ? "error" : "idle"
			});
		}
		if (evt.state === "aborted") {
			const wasActiveRun = state.activeChatRunId === evt.runId;
			chatLog.addSystem("run aborted");
			terminateRun({
				runId: evt.runId,
				wasActiveRun,
				status: "aborted"
			});
			maybeRefreshHistoryForRun(evt.runId);
		}
		if (evt.state === "error") {
			const wasActiveRun = state.activeChatRunId === evt.runId;
			chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
			terminateRun({
				runId: evt.runId,
				wasActiveRun,
				status: "error"
			});
			maybeRefreshHistoryForRun(evt.runId);
		}
		tui.requestRender();
	};
	const handleAgentEvent = (payload) => {
		if (!payload || typeof payload !== "object") return;
		const evt = payload;
		syncSessionKey();
		const isActiveRun = evt.runId === state.activeChatRunId;
		if (!(isActiveRun || sessionRuns.has(evt.runId) || finalizedRuns.has(evt.runId))) return;
		if (evt.stream === "tool") {
			const verbose = state.sessionInfo.verboseLevel ?? "off";
			const allowToolEvents = verbose !== "off";
			const allowToolOutput = verbose === "full";
			if (!allowToolEvents) return;
			const data = evt.data ?? {};
			const phase = asString(data.phase, "");
			const toolCallId = asString(data.toolCallId, "");
			const toolName = asString(data.name, "tool");
			if (!toolCallId) return;
			if (phase === "start") chatLog.startTool(toolCallId, toolName, data.args);
			else if (phase === "update") {
				if (!allowToolOutput) return;
				chatLog.updateToolResult(toolCallId, data.partialResult, { partial: true });
			} else if (phase === "result") if (allowToolOutput) chatLog.updateToolResult(toolCallId, data.result, { isError: Boolean(data.isError) });
			else chatLog.updateToolResult(toolCallId, { content: [] }, { isError: Boolean(data.isError) });
			tui.requestRender();
			return;
		}
		if (evt.stream === "lifecycle") {
			if (!isActiveRun) return;
			const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
			if (phase === "start") setActivityStatus("running");
			if (phase === "end") setActivityStatus("idle");
			if (phase === "error") setActivityStatus("error");
			tui.requestRender();
		}
	};
	return {
		handleChatEvent,
		handleAgentEvent
	};
}

//#endregion
//#region src/tui/tui-local-shell.ts
function createLocalShellRunner(deps) {
	let localExecAsked = false;
	let localExecAllowed = false;
	const createSelector = deps.createSelector ?? createSearchableSelectList;
	const spawnCommand = deps.spawnCommand ?? spawn;
	const getCwd = deps.getCwd ?? (() => process.cwd());
	const env = deps.env ?? process.env;
	const maxChars = deps.maxOutputChars ?? 4e4;
	const ensureLocalExecAllowed = async () => {
		if (localExecAllowed) return true;
		if (localExecAsked) return false;
		localExecAsked = true;
		return await new Promise((resolve) => {
			deps.chatLog.addSystem("Allow local shell commands for this session?");
			deps.chatLog.addSystem("This runs commands on YOUR machine (not the gateway) and may delete files or reveal secrets.");
			deps.chatLog.addSystem("Select Yes/No (arrows + Enter), Esc to cancel.");
			const selector = createSelector([{
				value: "no",
				label: "No"
			}, {
				value: "yes",
				label: "Yes"
			}], 2);
			selector.onSelect = (item) => {
				deps.closeOverlay();
				if (item.value === "yes") {
					localExecAllowed = true;
					deps.chatLog.addSystem("local shell: enabled for this session");
					resolve(true);
				} else {
					deps.chatLog.addSystem("local shell: not enabled");
					resolve(false);
				}
				deps.tui.requestRender();
			};
			selector.onCancel = () => {
				deps.closeOverlay();
				deps.chatLog.addSystem("local shell: cancelled");
				deps.tui.requestRender();
				resolve(false);
			};
			deps.openOverlay(selector);
			deps.tui.requestRender();
		});
	};
	const runLocalShellLine = async (line) => {
		const cmd = line.slice(1);
		if (cmd === "") return;
		if (localExecAsked && !localExecAllowed) {
			deps.chatLog.addSystem("local shell: not enabled for this session");
			deps.tui.requestRender();
			return;
		}
		if (!await ensureLocalExecAllowed()) return;
		deps.chatLog.addSystem(`[local] $ ${cmd}`);
		deps.tui.requestRender();
		const appendWithCap = (text, chunk) => {
			const combined = text + chunk;
			return combined.length > maxChars ? combined.slice(-maxChars) : combined;
		};
		await new Promise((resolve) => {
			const child = spawnCommand(cmd, {
				shell: true,
				cwd: getCwd(),
				env
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (buf) => {
				stdout = appendWithCap(stdout, buf.toString("utf8"));
			});
			child.stderr.on("data", (buf) => {
				stderr = appendWithCap(stderr, buf.toString("utf8"));
			});
			child.on("close", (code, signal) => {
				const combined = (stdout + (stderr ? (stdout ? "\n" : "") + stderr : "")).slice(0, maxChars).trimEnd();
				if (combined) for (const line of combined.split("\n")) deps.chatLog.addSystem(`[local] ${line}`);
				deps.chatLog.addSystem(`[local] exit ${code ?? "?"}${signal ? ` (signal ${String(signal)})` : ""}`);
				deps.tui.requestRender();
				resolve();
			});
			child.on("error", (err) => {
				deps.chatLog.addSystem(`[local] error: ${String(err)}`);
				deps.tui.requestRender();
				resolve();
			});
		});
	};
	return { runLocalShellLine };
}

//#endregion
//#region src/tui/tui-overlays.ts
function createOverlayHandlers(host, fallbackFocus) {
	const openOverlay = (component) => {
		host.showOverlay(component);
	};
	const closeOverlay = () => {
		if (host.hasOverlay()) {
			host.hideOverlay();
			return;
		}
		host.setFocus(fallbackFocus);
	};
	return {
		openOverlay,
		closeOverlay
	};
}

//#endregion
//#region src/tui/tui-session-actions.ts
function createSessionActions(context) {
	const { client, chatLog, tui, opts, state, agentNames, initialSessionInput, initialSessionAgentId, resolveSessionKey, updateHeader, updateFooter, updateAutocompleteProvider, setActivityStatus, clearLocalRunIds } = context;
	let refreshSessionInfoPromise = Promise.resolve();
	let lastSessionDefaults = null;
	const applyAgentsResult = (result) => {
		state.agentDefaultId = normalizeAgentId(result.defaultId);
		state.sessionMainKey = normalizeMainKey(result.mainKey);
		state.sessionScope = result.scope ?? state.sessionScope;
		state.agents = result.agents.map((agent) => ({
			id: normalizeAgentId(agent.id),
			name: agent.name?.trim() || void 0
		}));
		agentNames.clear();
		for (const agent of state.agents) if (agent.name) agentNames.set(agent.id, agent.name);
		if (!state.initialSessionApplied) {
			if (initialSessionAgentId) {
				if (state.agents.some((agent) => agent.id === initialSessionAgentId)) state.currentAgentId = initialSessionAgentId;
			} else if (!state.agents.some((agent) => agent.id === state.currentAgentId)) state.currentAgentId = state.agents[0]?.id ?? normalizeAgentId(result.defaultId ?? state.currentAgentId);
			const nextSessionKey = resolveSessionKey(initialSessionInput);
			if (nextSessionKey !== state.currentSessionKey) state.currentSessionKey = nextSessionKey;
			state.initialSessionApplied = true;
		} else if (!state.agents.some((agent) => agent.id === state.currentAgentId)) state.currentAgentId = state.agents[0]?.id ?? normalizeAgentId(result.defaultId ?? state.currentAgentId);
		updateHeader();
		updateFooter();
	};
	const refreshAgents = async () => {
		try {
			applyAgentsResult(await client.listAgents());
		} catch (err) {
			chatLog.addSystem(`agents list failed: ${String(err)}`);
		}
	};
	const updateAgentFromSessionKey = (key) => {
		const parsed = parseAgentSessionKey(key);
		if (!parsed) return;
		const next = normalizeAgentId(parsed.agentId);
		if (next !== state.currentAgentId) state.currentAgentId = next;
	};
	const resolveModelSelection = (entry) => {
		if (entry?.modelProvider || entry?.model) return {
			modelProvider: entry.modelProvider ?? state.sessionInfo.modelProvider,
			model: entry.model ?? state.sessionInfo.model
		};
		const overrideModel = entry?.modelOverride?.trim();
		if (overrideModel) return {
			modelProvider: entry?.providerOverride?.trim() || state.sessionInfo.modelProvider,
			model: overrideModel
		};
		return {
			modelProvider: state.sessionInfo.modelProvider,
			model: state.sessionInfo.model
		};
	};
	const applySessionInfo = (params) => {
		const entry = params.entry ?? void 0;
		const defaults = params.defaults ?? lastSessionDefaults ?? void 0;
		const previousDefaults = lastSessionDefaults;
		const defaultsChanged = params.defaults ? previousDefaults?.model !== params.defaults.model || previousDefaults?.modelProvider !== params.defaults.modelProvider || previousDefaults?.contextTokens !== params.defaults.contextTokens : false;
		if (params.defaults) lastSessionDefaults = params.defaults;
		const entryUpdatedAt = entry?.updatedAt ?? null;
		const currentUpdatedAt = state.sessionInfo.updatedAt ?? null;
		const modelChanged = entry?.modelProvider !== void 0 && entry.modelProvider !== state.sessionInfo.modelProvider || entry?.model !== void 0 && entry.model !== state.sessionInfo.model;
		if (!params.force && entryUpdatedAt !== null && currentUpdatedAt !== null && entryUpdatedAt < currentUpdatedAt && !defaultsChanged && !modelChanged) return;
		const next = { ...state.sessionInfo };
		if (entry?.thinkingLevel !== void 0) next.thinkingLevel = entry.thinkingLevel;
		if (entry?.verboseLevel !== void 0) next.verboseLevel = entry.verboseLevel;
		if (entry?.reasoningLevel !== void 0) next.reasoningLevel = entry.reasoningLevel;
		if (entry?.responseUsage !== void 0) next.responseUsage = entry.responseUsage;
		if (entry?.inputTokens !== void 0) next.inputTokens = entry.inputTokens;
		if (entry?.outputTokens !== void 0) next.outputTokens = entry.outputTokens;
		if (entry?.totalTokens !== void 0) next.totalTokens = entry.totalTokens;
		if (entry?.contextTokens !== void 0 || defaults?.contextTokens !== void 0) next.contextTokens = entry?.contextTokens ?? defaults?.contextTokens ?? state.sessionInfo.contextTokens;
		if (entry?.displayName !== void 0) next.displayName = entry.displayName;
		if (entry?.updatedAt !== void 0) next.updatedAt = entry.updatedAt;
		const selection = resolveModelSelection(entry);
		if (selection.modelProvider !== void 0) next.modelProvider = selection.modelProvider;
		if (selection.model !== void 0) next.model = selection.model;
		state.sessionInfo = next;
		updateAutocompleteProvider();
		updateFooter();
		tui.requestRender();
	};
	const runRefreshSessionInfo = async () => {
		try {
			const resolveListAgentId = () => {
				if (state.currentSessionKey === "global" || state.currentSessionKey === "unknown") return;
				const parsed = parseAgentSessionKey(state.currentSessionKey);
				return parsed?.agentId ? normalizeAgentId(parsed.agentId) : state.currentAgentId;
			};
			const listAgentId = resolveListAgentId();
			const result = await client.listSessions({
				includeGlobal: false,
				includeUnknown: false,
				agentId: listAgentId
			});
			const normalizeMatchKey = (key) => parseAgentSessionKey(key)?.rest ?? key;
			const currentMatchKey = normalizeMatchKey(state.currentSessionKey);
			const entry = result.sessions.find((row) => {
				if (row.key === state.currentSessionKey) return true;
				return normalizeMatchKey(row.key) === currentMatchKey;
			});
			if (entry?.key && entry.key !== state.currentSessionKey) {
				updateAgentFromSessionKey(entry.key);
				state.currentSessionKey = entry.key;
				updateHeader();
			}
			applySessionInfo({
				entry,
				defaults: result.defaults
			});
		} catch (err) {
			chatLog.addSystem(`sessions list failed: ${String(err)}`);
		}
	};
	const refreshSessionInfo = async () => {
		refreshSessionInfoPromise = refreshSessionInfoPromise.then(runRefreshSessionInfo, runRefreshSessionInfo);
		await refreshSessionInfoPromise;
	};
	const applySessionInfoFromPatch = (result) => {
		if (!result?.entry) return;
		if (result.key && result.key !== state.currentSessionKey) {
			updateAgentFromSessionKey(result.key);
			state.currentSessionKey = result.key;
			updateHeader();
		}
		const resolved = result.resolved;
		applySessionInfo({
			entry: resolved && (resolved.modelProvider || resolved.model) ? {
				...result.entry,
				modelProvider: resolved.modelProvider ?? result.entry.modelProvider,
				model: resolved.model ?? result.entry.model
			} : result.entry,
			force: true
		});
	};
	const loadHistory = async () => {
		try {
			const record = await client.loadHistory({
				sessionKey: state.currentSessionKey,
				limit: opts.historyLimit ?? 200
			});
			state.currentSessionId = typeof record.sessionId === "string" ? record.sessionId : null;
			state.sessionInfo.thinkingLevel = record.thinkingLevel ?? state.sessionInfo.thinkingLevel;
			state.sessionInfo.verboseLevel = record.verboseLevel ?? state.sessionInfo.verboseLevel;
			const showTools = (state.sessionInfo.verboseLevel ?? "off") !== "off";
			chatLog.clearAll();
			chatLog.addSystem(`session ${state.currentSessionKey}`);
			for (const entry of record.messages ?? []) {
				if (!entry || typeof entry !== "object") continue;
				const message = entry;
				if (isCommandMessage(message)) {
					const text = extractTextFromMessage(message);
					if (text) chatLog.addSystem(text);
					continue;
				}
				if (message.role === "user") {
					const text = extractTextFromMessage(message);
					if (text) chatLog.addUser(text);
					continue;
				}
				if (message.role === "assistant") {
					const text = extractTextFromMessage(message, { includeThinking: state.showThinking });
					if (text) chatLog.finalizeAssistant(text);
					continue;
				}
				if (message.role === "toolResult") {
					if (!showTools) continue;
					const toolCallId = asString(message.toolCallId, "");
					const toolName = asString(message.toolName, "tool");
					chatLog.startTool(toolCallId, toolName, {}).setResult({
						content: Array.isArray(message.content) ? message.content : [],
						details: typeof message.details === "object" && message.details ? message.details : void 0
					}, { isError: Boolean(message.isError) });
				}
			}
			state.historyLoaded = true;
		} catch (err) {
			chatLog.addSystem(`history failed: ${String(err)}`);
		}
		await refreshSessionInfo();
		tui.requestRender();
	};
	const setSession = async (rawKey) => {
		const nextKey = resolveSessionKey(rawKey);
		updateAgentFromSessionKey(nextKey);
		state.currentSessionKey = nextKey;
		state.activeChatRunId = null;
		state.currentSessionId = null;
		state.historyLoaded = false;
		clearLocalRunIds?.();
		updateHeader();
		updateFooter();
		await loadHistory();
	};
	const abortActive = async () => {
		if (!state.activeChatRunId) {
			chatLog.addSystem("no active run");
			tui.requestRender();
			return;
		}
		try {
			await client.abortChat({
				sessionKey: state.currentSessionKey,
				runId: state.activeChatRunId
			});
			setActivityStatus("aborted");
		} catch (err) {
			chatLog.addSystem(`abort failed: ${String(err)}`);
			setActivityStatus("abort failed");
		}
		tui.requestRender();
	};
	return {
		applyAgentsResult,
		refreshAgents,
		refreshSessionInfo,
		applySessionInfoFromPatch,
		loadHistory,
		setSession,
		abortActive
	};
}

//#endregion
//#region src/tui/tui-waiting.ts
const defaultWaitingPhrases = [
	"flibbertigibbeting",
	"kerfuffling",
	"dillydallying",
	"twiddling thumbs",
	"noodling",
	"bamboozling",
	"moseying",
	"hobnobbing",
	"pondering",
	"conjuring"
];
function pickWaitingPhrase(tick, phrases = defaultWaitingPhrases) {
	return phrases[Math.floor(tick / 10) % phrases.length] ?? phrases[0] ?? "waiting";
}
function shimmerText(theme, text, tick) {
	const width = 6;
	const hi = (ch) => theme.bold(theme.accentSoft(ch));
	const pos = tick % (text.length + width);
	const start = Math.max(0, pos - width);
	const end = Math.min(text.length - 1, pos);
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		out += i >= start && i <= end ? hi(ch) : theme.dim(ch);
	}
	return out;
}
function buildWaitingStatusMessage(params) {
	const phrase = pickWaitingPhrase(params.tick, params.phrases);
	return `${shimmerText(params.theme, `${phrase}…`, params.tick)} • ${params.elapsed} | ${params.connectionStatus}`;
}

//#endregion
//#region src/tui/tui.ts
function createEditorSubmitHandler(params) {
	return (text) => {
		const raw = text;
		const value = raw.trim();
		params.editor.setText("");
		if (!value) return;
		if (raw.startsWith("!") && raw !== "!") {
			params.editor.addToHistory(raw);
			params.handleBangLine(raw);
			return;
		}
		params.editor.addToHistory(value);
		if (value.startsWith("/")) {
			params.handleCommand(value);
			return;
		}
		params.sendMessage(value);
	};
}
function shouldEnableWindowsGitBashPasteFallback(params) {
	const platform = params?.platform ?? process.platform;
	const env = params?.env ?? process.env;
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	if (platform === "darwin") {
		if (termProgram.includes("iterm") || termProgram.includes("apple_terminal")) return true;
		return false;
	}
	if (platform !== "win32") return false;
	const msystem = (env.MSYSTEM ?? "").toUpperCase();
	const shell = env.SHELL ?? "";
	if (msystem.startsWith("MINGW") || msystem.startsWith("MSYS")) return true;
	if (shell.toLowerCase().includes("bash")) return true;
	return termProgram.includes("mintty");
}
function createSubmitBurstCoalescer(params) {
	const windowMs = Math.max(1, params.burstWindowMs ?? 50);
	const now = params.now ?? (() => Date.now());
	const setTimer = params.setTimer ?? setTimeout;
	const clearTimer = params.clearTimer ?? clearTimeout;
	let pending = null;
	let pendingAt = 0;
	let flushTimer = null;
	const clearFlushTimer = () => {
		if (!flushTimer) return;
		clearTimer(flushTimer);
		flushTimer = null;
	};
	const flushPending = () => {
		if (pending === null) return;
		const value = pending;
		pending = null;
		pendingAt = 0;
		clearFlushTimer();
		params.submit(value);
	};
	const scheduleFlush = () => {
		clearFlushTimer();
		flushTimer = setTimer(() => {
			flushPending();
		}, windowMs);
	};
	return (value) => {
		if (!params.enabled) {
			params.submit(value);
			return;
		}
		if (value.includes("\n")) {
			flushPending();
			params.submit(value);
			return;
		}
		const ts = now();
		if (pending === null) {
			pending = value;
			pendingAt = ts;
			scheduleFlush();
			return;
		}
		if (ts - pendingAt <= windowMs) {
			pending = `${pending}\n${value}`;
			pendingAt = ts;
			scheduleFlush();
			return;
		}
		flushPending();
		pending = value;
		pendingAt = ts;
		scheduleFlush();
	};
}
function resolveTuiSessionKey(params) {
	const trimmed = (params.raw ?? "").trim();
	if (!trimmed) {
		if (params.sessionScope === "global") return "global";
		return buildAgentMainSessionKey({
			agentId: params.currentAgentId,
			mainKey: params.sessionMainKey
		});
	}
	if (trimmed === "global" || trimmed === "unknown") return trimmed;
	if (trimmed.startsWith("agent:")) return trimmed;
	return `agent:${params.currentAgentId}:${trimmed}`;
}
function resolveGatewayDisconnectState(reason) {
	const reasonLabel = reason?.trim() ? reason.trim() : "closed";
	if (/pairing required/i.test(reasonLabel)) return {
		connectionStatus: `gateway disconnected: ${reasonLabel}`,
		activityStatus: "pairing required: run openclaw devices list",
		pairingHint: "Pairing required. Run `openclaw devices list`, approve your request ID, then reconnect."
	};
	return {
		connectionStatus: `gateway disconnected: ${reasonLabel}`,
		activityStatus: "idle"
	};
}
function createBackspaceDeduper(params) {
	const dedupeWindowMs = Math.max(0, Math.floor(params?.dedupeWindowMs ?? 8));
	const now = params?.now ?? (() => Date.now());
	let lastBackspaceAt = -1;
	return (data) => {
		if (!matchesKey(data, Key.backspace)) return data;
		const ts = now();
		if (lastBackspaceAt >= 0 && ts - lastBackspaceAt <= dedupeWindowMs) return "";
		lastBackspaceAt = ts;
		return data;
	};
}
function isIgnorableTuiStopError(error) {
	if (!error || typeof error !== "object") return false;
	const err = error;
	const code = typeof err.code === "string" ? err.code : "";
	const syscall = typeof err.syscall === "string" ? err.syscall : "";
	const message = typeof err.message === "string" ? err.message : "";
	if (code === "EBADF" && syscall === "setRawMode") return true;
	return /setRawMode/i.test(message) && /EBADF/i.test(message);
}
function stopTuiSafely(stop) {
	try {
		stop();
	} catch (error) {
		if (!isIgnorableTuiStopError(error)) throw error;
	}
}
function resolveCtrlCAction(params) {
	const exitWindowMs = Math.max(1, Math.floor(params.exitWindowMs ?? 1e3));
	if (params.hasInput) return {
		action: "clear",
		nextLastCtrlCAt: params.now
	};
	if (params.now - params.lastCtrlCAt <= exitWindowMs) return {
		action: "exit",
		nextLastCtrlCAt: params.lastCtrlCAt
	};
	return {
		action: "warn",
		nextLastCtrlCAt: params.now
	};
}
async function runTui(opts) {
	const config = loadConfig();
	const initialSessionInput = (opts.session ?? "").trim();
	let sessionScope = config.session?.scope ?? "per-sender";
	let sessionMainKey = normalizeMainKey(config.session?.mainKey);
	let agentDefaultId = resolveDefaultAgentId(config);
	let currentAgentId = agentDefaultId;
	let agents = [];
	const agentNames = /* @__PURE__ */ new Map();
	let currentSessionKey = "";
	let initialSessionApplied = false;
	let currentSessionId = null;
	let activeChatRunId = null;
	let historyLoaded = false;
	let isConnected = false;
	let wasDisconnected = false;
	let toolsExpanded = false;
	let showThinking = false;
	let pairingHintShown = false;
	const localRunIds = /* @__PURE__ */ new Set();
	const deliverDefault = opts.deliver ?? false;
	const autoMessage = opts.message?.trim();
	let autoMessageSent = false;
	let sessionInfo = {};
	let lastCtrlCAt = 0;
	let exitRequested = false;
	let activityStatus = "idle";
	let connectionStatus = "connecting";
	let statusTimeout = null;
	let statusTimer = null;
	let statusStartedAt = null;
	let lastActivityStatus = activityStatus;
	const state = {
		get agentDefaultId() {
			return agentDefaultId;
		},
		set agentDefaultId(value) {
			agentDefaultId = value;
		},
		get sessionMainKey() {
			return sessionMainKey;
		},
		set sessionMainKey(value) {
			sessionMainKey = value;
		},
		get sessionScope() {
			return sessionScope;
		},
		set sessionScope(value) {
			sessionScope = value;
		},
		get agents() {
			return agents;
		},
		set agents(value) {
			agents = value;
		},
		get currentAgentId() {
			return currentAgentId;
		},
		set currentAgentId(value) {
			currentAgentId = value;
		},
		get currentSessionKey() {
			return currentSessionKey;
		},
		set currentSessionKey(value) {
			currentSessionKey = value;
		},
		get currentSessionId() {
			return currentSessionId;
		},
		set currentSessionId(value) {
			currentSessionId = value;
		},
		get activeChatRunId() {
			return activeChatRunId;
		},
		set activeChatRunId(value) {
			activeChatRunId = value;
		},
		get historyLoaded() {
			return historyLoaded;
		},
		set historyLoaded(value) {
			historyLoaded = value;
		},
		get sessionInfo() {
			return sessionInfo;
		},
		set sessionInfo(value) {
			sessionInfo = value;
		},
		get initialSessionApplied() {
			return initialSessionApplied;
		},
		set initialSessionApplied(value) {
			initialSessionApplied = value;
		},
		get isConnected() {
			return isConnected;
		},
		set isConnected(value) {
			isConnected = value;
		},
		get autoMessageSent() {
			return autoMessageSent;
		},
		set autoMessageSent(value) {
			autoMessageSent = value;
		},
		get toolsExpanded() {
			return toolsExpanded;
		},
		set toolsExpanded(value) {
			toolsExpanded = value;
		},
		get showThinking() {
			return showThinking;
		},
		set showThinking(value) {
			showThinking = value;
		},
		get connectionStatus() {
			return connectionStatus;
		},
		set connectionStatus(value) {
			connectionStatus = value;
		},
		get activityStatus() {
			return activityStatus;
		},
		set activityStatus(value) {
			activityStatus = value;
		},
		get statusTimeout() {
			return statusTimeout;
		},
		set statusTimeout(value) {
			statusTimeout = value;
		},
		get lastCtrlCAt() {
			return lastCtrlCAt;
		},
		set lastCtrlCAt(value) {
			lastCtrlCAt = value;
		}
	};
	const noteLocalRunId = (runId) => {
		if (!runId) return;
		localRunIds.add(runId);
		if (localRunIds.size > 200) {
			const [first] = localRunIds;
			if (first) localRunIds.delete(first);
		}
	};
	const forgetLocalRunId = (runId) => {
		localRunIds.delete(runId);
	};
	const isLocalRunId = (runId) => localRunIds.has(runId);
	const clearLocalRunIds = () => {
		localRunIds.clear();
	};
	const client = new GatewayChatClient({
		url: opts.url,
		token: opts.token,
		password: opts.password
	});
	const tui = new TUI(new ProcessTerminal());
	const dedupeBackspace = createBackspaceDeduper();
	tui.addInputListener((data) => {
		const next = dedupeBackspace(data);
		if (next.length === 0) return { consume: true };
		return { data: next };
	});
	const header = new Text("", 1, 0);
	const statusContainer = new Container();
	const footer = new Text("", 1, 0);
	const chatLog = new ChatLog();
	const editor = new CustomEditor(tui, editorTheme);
	const root = new Container();
	root.addChild(header);
	root.addChild(chatLog);
	root.addChild(statusContainer);
	root.addChild(footer);
	root.addChild(editor);
	const updateAutocompleteProvider = () => {
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(getSlashCommands({
			cfg: config,
			provider: sessionInfo.modelProvider,
			model: sessionInfo.model
		}), process.cwd()));
	};
	tui.addChild(root);
	tui.setFocus(editor);
	const formatSessionKey = (key) => {
		if (key === "global" || key === "unknown") return key;
		return parseAgentSessionKey(key)?.rest ?? key;
	};
	const formatAgentLabel = (id) => {
		const name = agentNames.get(id);
		return name ? `${id} (${name})` : id;
	};
	const resolveSessionKey = (raw) => {
		return resolveTuiSessionKey({
			raw,
			sessionScope,
			currentAgentId,
			sessionMainKey
		});
	};
	currentSessionKey = resolveSessionKey(initialSessionInput);
	const updateHeader = () => {
		const sessionLabel = formatSessionKey(currentSessionKey);
		const agentLabel = formatAgentLabel(currentAgentId);
		header.setText(theme.header(`openclaw tui - ${client.connection.url} - agent ${agentLabel} - session ${sessionLabel}`));
	};
	const busyStates = new Set([
		"sending",
		"waiting",
		"streaming",
		"running"
	]);
	let statusText = null;
	let statusLoader = null;
	const formatElapsed = (startMs) => {
		const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1e3));
		if (totalSeconds < 60) return `${totalSeconds}s`;
		return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
	};
	const ensureStatusText = () => {
		if (statusText) return;
		statusContainer.clear();
		statusLoader?.stop();
		statusLoader = null;
		statusText = new Text("", 1, 0);
		statusContainer.addChild(statusText);
	};
	const ensureStatusLoader = () => {
		if (statusLoader) return;
		statusContainer.clear();
		statusText = null;
		statusLoader = new Loader(tui, (spinner) => theme.accent(spinner), (text) => theme.bold(theme.accentSoft(text)), "");
		statusContainer.addChild(statusLoader);
	};
	let waitingTick = 0;
	let waitingTimer = null;
	let waitingPhrase = null;
	const updateBusyStatusMessage = () => {
		if (!statusLoader || !statusStartedAt) return;
		const elapsed = formatElapsed(statusStartedAt);
		if (activityStatus === "waiting") {
			waitingTick++;
			statusLoader.setMessage(buildWaitingStatusMessage({
				theme,
				tick: waitingTick,
				elapsed,
				connectionStatus,
				phrases: waitingPhrase ? [waitingPhrase] : void 0
			}));
			return;
		}
		statusLoader.setMessage(`${activityStatus} • ${elapsed} | ${connectionStatus}`);
	};
	const startStatusTimer = () => {
		if (statusTimer) return;
		statusTimer = setInterval(() => {
			if (!busyStates.has(activityStatus)) return;
			updateBusyStatusMessage();
		}, 1e3);
	};
	const stopStatusTimer = () => {
		if (!statusTimer) return;
		clearInterval(statusTimer);
		statusTimer = null;
	};
	const startWaitingTimer = () => {
		if (waitingTimer) return;
		if (!waitingPhrase) waitingPhrase = defaultWaitingPhrases[Math.floor(Math.random() * defaultWaitingPhrases.length)] ?? defaultWaitingPhrases[0] ?? "waiting";
		waitingTick = 0;
		waitingTimer = setInterval(() => {
			if (activityStatus !== "waiting") return;
			updateBusyStatusMessage();
		}, 120);
	};
	const stopWaitingTimer = () => {
		if (!waitingTimer) return;
		clearInterval(waitingTimer);
		waitingTimer = null;
		waitingPhrase = null;
	};
	const renderStatus = () => {
		if (busyStates.has(activityStatus)) {
			if (!statusStartedAt || lastActivityStatus !== activityStatus) statusStartedAt = Date.now();
			ensureStatusLoader();
			if (activityStatus === "waiting") {
				stopStatusTimer();
				startWaitingTimer();
			} else {
				stopWaitingTimer();
				startStatusTimer();
			}
			updateBusyStatusMessage();
		} else {
			statusStartedAt = null;
			stopStatusTimer();
			stopWaitingTimer();
			statusLoader?.stop();
			statusLoader = null;
			ensureStatusText();
			const text = activityStatus ? `${connectionStatus} | ${activityStatus}` : connectionStatus;
			statusText?.setText(theme.dim(text));
		}
		lastActivityStatus = activityStatus;
	};
	const setConnectionStatus = (text, ttlMs) => {
		connectionStatus = text;
		renderStatus();
		if (statusTimeout) clearTimeout(statusTimeout);
		if (ttlMs && ttlMs > 0) statusTimeout = setTimeout(() => {
			connectionStatus = isConnected ? "connected" : "disconnected";
			renderStatus();
		}, ttlMs);
	};
	const setActivityStatus = (text) => {
		activityStatus = text;
		renderStatus();
	};
	const updateFooter = () => {
		const sessionKeyLabel = formatSessionKey(currentSessionKey);
		const sessionLabel = sessionInfo.displayName ? `${sessionKeyLabel} (${sessionInfo.displayName})` : sessionKeyLabel;
		const agentLabel = formatAgentLabel(currentAgentId);
		const modelLabel = sessionInfo.model ? sessionInfo.modelProvider ? `${sessionInfo.modelProvider}/${sessionInfo.model}` : sessionInfo.model : "unknown";
		const tokens = formatTokens(sessionInfo.totalTokens ?? null, sessionInfo.contextTokens ?? null);
		const think = sessionInfo.thinkingLevel ?? "off";
		const verbose = sessionInfo.verboseLevel ?? "off";
		const reasoning = sessionInfo.reasoningLevel ?? "off";
		const reasoningLabel = reasoning === "on" ? "reasoning" : reasoning === "stream" ? "reasoning:stream" : null;
		const footerParts = [
			`agent ${agentLabel}`,
			`session ${sessionLabel}`,
			modelLabel,
			think !== "off" ? `think ${think}` : null,
			verbose !== "off" ? `verbose ${verbose}` : null,
			reasoningLabel,
			tokens
		].filter(Boolean);
		footer.setText(theme.dim(footerParts.join(" | ")));
	};
	const { openOverlay, closeOverlay } = createOverlayHandlers(tui, editor);
	const { refreshAgents, refreshSessionInfo, applySessionInfoFromPatch, loadHistory, setSession, abortActive } = createSessionActions({
		client,
		chatLog,
		tui,
		opts,
		state,
		agentNames,
		initialSessionInput,
		initialSessionAgentId: (() => {
			if (!initialSessionInput) return null;
			const parsed = parseAgentSessionKey(initialSessionInput);
			return parsed ? normalizeAgentId(parsed.agentId) : null;
		})(),
		resolveSessionKey,
		updateHeader,
		updateFooter,
		updateAutocompleteProvider,
		setActivityStatus,
		clearLocalRunIds
	});
	const { handleChatEvent, handleAgentEvent } = createEventHandlers({
		chatLog,
		tui,
		state,
		setActivityStatus,
		refreshSessionInfo,
		loadHistory,
		isLocalRunId,
		forgetLocalRunId,
		clearLocalRunIds
	});
	const requestExit = () => {
		if (exitRequested) return;
		exitRequested = true;
		client.stop();
		stopTuiSafely(() => tui.stop());
		process.exit(0);
	};
	const { handleCommand, sendMessage, openModelSelector, openAgentSelector, openSessionSelector } = createCommandHandlers({
		client,
		chatLog,
		tui,
		opts,
		state,
		deliverDefault,
		openOverlay,
		closeOverlay,
		refreshSessionInfo,
		applySessionInfoFromPatch,
		loadHistory,
		setSession,
		refreshAgents,
		abortActive,
		setActivityStatus,
		formatSessionKey,
		noteLocalRunId,
		forgetLocalRunId,
		requestExit
	});
	const { runLocalShellLine } = createLocalShellRunner({
		chatLog,
		tui,
		openOverlay,
		closeOverlay
	});
	updateAutocompleteProvider();
	editor.onSubmit = createSubmitBurstCoalescer({
		submit: createEditorSubmitHandler({
			editor,
			handleCommand,
			sendMessage,
			handleBangLine: runLocalShellLine
		}),
		enabled: shouldEnableWindowsGitBashPasteFallback()
	});
	editor.onEscape = () => {
		abortActive();
	};
	const handleCtrlC = () => {
		const now = Date.now();
		const decision = resolveCtrlCAction({
			hasInput: editor.getText().trim().length > 0,
			now,
			lastCtrlCAt
		});
		lastCtrlCAt = decision.nextLastCtrlCAt;
		if (decision.action === "clear") {
			editor.setText("");
			setActivityStatus("cleared input; press ctrl+c again to exit");
			tui.requestRender();
			return;
		}
		if (decision.action === "exit") {
			requestExit();
			return;
		}
		setActivityStatus("press ctrl+c again to exit");
		tui.requestRender();
	};
	editor.onCtrlC = () => {
		handleCtrlC();
	};
	editor.onCtrlD = () => {
		requestExit();
	};
	editor.onCtrlO = () => {
		toolsExpanded = !toolsExpanded;
		chatLog.setToolsExpanded(toolsExpanded);
		setActivityStatus(toolsExpanded ? "tools expanded" : "tools collapsed");
		tui.requestRender();
	};
	editor.onCtrlL = () => {
		openModelSelector();
	};
	editor.onCtrlG = () => {
		openAgentSelector();
	};
	editor.onCtrlP = () => {
		openSessionSelector();
	};
	editor.onCtrlT = () => {
		showThinking = !showThinking;
		loadHistory();
	};
	client.onEvent = (evt) => {
		if (evt.event === "chat") handleChatEvent(evt.payload);
		if (evt.event === "agent") handleAgentEvent(evt.payload);
	};
	client.onConnected = () => {
		isConnected = true;
		pairingHintShown = false;
		const reconnected = wasDisconnected;
		wasDisconnected = false;
		setConnectionStatus("connected");
		(async () => {
			await refreshAgents();
			updateHeader();
			await loadHistory();
			setConnectionStatus(reconnected ? "gateway reconnected" : "gateway connected", 4e3);
			tui.requestRender();
			if (!autoMessageSent && autoMessage) {
				autoMessageSent = true;
				await sendMessage(autoMessage);
			}
			updateFooter();
			tui.requestRender();
		})();
	};
	client.onDisconnected = (reason) => {
		isConnected = false;
		wasDisconnected = true;
		historyLoaded = false;
		const disconnectState = resolveGatewayDisconnectState(reason);
		setConnectionStatus(disconnectState.connectionStatus, 5e3);
		setActivityStatus(disconnectState.activityStatus);
		if (disconnectState.pairingHint && !pairingHintShown) {
			pairingHintShown = true;
			chatLog.addSystem(disconnectState.pairingHint);
		}
		updateFooter();
		tui.requestRender();
	};
	client.onGap = (info) => {
		setConnectionStatus(`event gap: expected ${info.expected}, got ${info.received}`, 5e3);
		tui.requestRender();
	};
	updateHeader();
	setConnectionStatus("connecting");
	updateFooter();
	const sigintHandler = () => {
		handleCtrlC();
	};
	const sigtermHandler = () => {
		requestExit();
	};
	process.on("SIGINT", sigintHandler);
	process.on("SIGTERM", sigtermHandler);
	tui.start();
	client.start();
	await new Promise((resolve) => {
		const finish = () => {
			process.removeListener("SIGINT", sigintHandler);
			process.removeListener("SIGTERM", sigtermHandler);
			resolve();
		};
		process.once("exit", finish);
	});
}

//#endregion
export { runTui as t };