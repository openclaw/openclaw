import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as visibleWidth, r as stripAnsi$1 } from "./ansi-4r6vVvJt.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { u as registerUncaughtExceptionHandler } from "./unhandled-rejections-Km9wbHjh.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { c as resolveAgentIdByWorkspacePath } from "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId, r as buildAgentMainSessionKey, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { n as assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy-DXdptBl7.js";
import { t as loggingState } from "./state-CHRYWIGY.js";
import { s as setConsoleSubsystemFilter } from "./console-BAPPAj56.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as modelKey } from "./model-ref-shared-BkjJfDrJ.js";
import { _ as resolveResponseUsageMode, h as normalizeUsageDisplay, r as listThinkingLevelLabels, t as formatThinkingLevels } from "./thinking-DNSlsULp.js";
import "./config-B6Oplu5W.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES, t as GATEWAY_CLIENT_CAPS } from "./client-info-BVWE_ra1.js";
import { t as startGatewayClientWhenEventLoopReady } from "./client-start-readiness-zY0I9Wur.js";
import { n as GatewayClient, r as GatewayClientRequestError } from "./client-B1EH_7Mz.js";
import "./protocol-DiXjp30g.js";
import "./version-DDqbebEG.js";
import { d as resolveExplicitGatewayAuth, n as buildGatewayConnectionDetails, s as ensureExplicitGatewayAuth } from "./call-t1U2G3yY.js";
import { n as extractAssistantVisibleText } from "./chat-message-content-DN9xEd6w.js";
import { r as stripLeadingInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { r as formatRawAssistantErrorForUi } from "./assistant-error-format-CuUvHfKt.js";
import { t as isAuthErrorMessage } from "./failover-matches-C-tab7FS.js";
import { n as formatTokenCount } from "./usage-format-BEywPhmZ.js";
import "./pi-embedded-helpers-bmljPI1n.js";
import { r as resolveToolDisplay, t as formatToolDetail } from "./tool-display-CN2B3x-5.js";
import { r as resolveSessionInfoModelSelection } from "./model-selection-display-BOUwZcnd.js";
import { n as listChatCommands, r as listChatCommandsForConfig } from "./commands-registry-list--98FRviq.js";
import "./commands-registry-Bthd8JBl.js";
import { n as formatTimeAgo, t as formatRelativeTimestamp } from "./format-relative-Bjc3l98W.js";
import { t as normalizeGroupActivation } from "./group-activation-BxkIP-sT.js";
import { t as resolveGatewayInteractiveSurfaceAuth } from "./auth-surface-resolution-DO1glHlZ.js";
import { n as TUI_SETUP_AUTH_SOURCE_ENV, t as TUI_SETUP_AUTH_SOURCE_CONFIG } from "./setup-launch-env-DehdAyoV.js";
import { t as resolveLocalRunShutdownGraceMs } from "./local-run-shutdown-B71jGMgK.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import chalk from "chalk";
import { createHash, randomUUID } from "node:crypto";
import { Box, CombinedAutocompleteProvider, Container, Editor, Input, Key, Loader, Markdown, ProcessTerminal, SelectList, SettingsList, Spacer, TUI, Text, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
//#region src/tui/commands.ts
const VERBOSE_LEVELS = ["on", "off"];
const TRACE_LEVELS = ["on", "off"];
const FAST_LEVELS = [
	"status",
	"on",
	"off"
];
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
const COMMAND_ALIASES = {
	elev: "elevated",
	gwstatus: "gateway-status"
};
function createLevelCompletion(levels) {
	return (prefix) => levels.filter((value) => value.startsWith(normalizeLowercaseStringOrEmpty(prefix))).map((value) => ({
		value,
		label: value
	}));
}
function normalizeSlashCommandName(value) {
	return value.replace(/^\//, "").trim();
}
function appendSlashCommand(commands, seen, name, description) {
	const normalizedName = normalizeSlashCommandName(name);
	if (!normalizedName || seen.has(normalizedName)) return;
	seen.add(normalizedName);
	commands.push({
		name: normalizedName,
		description
	});
}
function parseCommand(input) {
	const trimmed = input.replace(/^\//, "").trim();
	if (!trimmed) return {
		name: "",
		args: ""
	};
	const [name, ...rest] = trimmed.split(/\s+/);
	const normalized = normalizeLowercaseStringOrEmpty(name);
	return {
		name: COMMAND_ALIASES[normalized] ?? normalized,
		args: rest.join(" ").trim()
	};
}
function getSlashCommands(options = {}) {
	const thinkLevels = options.thinkingLevels?.length ? options.thinkingLevels.map((level) => level.label) : listThinkingLevelLabels(options.provider, options.model);
	const verboseCompletions = createLevelCompletion(VERBOSE_LEVELS);
	const traceCompletions = createLevelCompletion(TRACE_LEVELS);
	const fastCompletions = createLevelCompletion(FAST_LEVELS);
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
			name: "gateway-status",
			description: "Show gateway status summary"
		},
		{
			name: "gwstatus",
			description: "Alias for /gateway-status"
		},
		...options.local ? [{
			name: "auth",
			description: "Run provider auth/login flow"
		}] : [],
		{
			name: "agent",
			description: "Switch agent (or open picker)"
		},
		{
			name: "agents",
			description: "Open agent picker"
		},
		{
			name: "crestodian",
			description: "Return to Crestodian"
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
			getArgumentCompletions: (prefix) => thinkLevels.filter((v) => v.startsWith(normalizeLowercaseStringOrEmpty(prefix))).map((value) => ({
				value,
				label: value
			}))
		},
		{
			name: "fast",
			description: "Set fast mode on/off",
			getArgumentCompletions: fastCompletions
		},
		{
			name: "verbose",
			description: "Set verbose on/off",
			getArgumentCompletions: verboseCompletions
		},
		{
			name: "trace",
			description: "Set trace on/off",
			getArgumentCompletions: traceCompletions
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
		for (const alias of aliases) appendSlashCommand(commands, seen, alias, command.description);
	}
	for (const command of options.dynamicCommands ?? []) {
		const aliases = command.textAliases?.length ? command.textAliases : [command.name];
		for (const alias of aliases) appendSlashCommand(commands, seen, alias, command.description);
	}
	return commands;
}
function helpText(options = {}) {
	const thinkLevels = formatThinkingLevels(options.provider, options.model, "|");
	return [
		"Slash commands:",
		"/help",
		"/commands",
		"/status",
		"/gateway-status",
		"/gwstatus",
		...options.local ? ["/auth [provider]"] : [],
		"/agent <id> (or /agents)",
		"/crestodian [request]",
		"/session <key> (or /sessions)",
		"/model <provider/model> (or /models)",
		`/think <${thinkLevels}>`,
		"/fast <status|on|off>",
		"/verbose <on|off>",
		"/trace <on|off>",
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
//#region src/tui/theme/theme.ts
const DARK_TEXT = "#E8E3D5";
const LIGHT_TEXT = "#1E1E1E";
const XTERM_LEVELS = [
	0,
	95,
	135,
	175,
	215,
	255
];
function channelToSrgb(value) {
	const normalized = value / 255;
	return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
}
function relativeLuminanceRgb(r, g, b) {
	const red = channelToSrgb(r);
	const green = channelToSrgb(g);
	const blue = channelToSrgb(b);
	return .2126 * red + .7152 * green + .0722 * blue;
}
function relativeLuminanceHex(hex) {
	return relativeLuminanceRgb(Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16));
}
function contrastRatio(background, foregroundHex) {
	const foreground = relativeLuminanceHex(foregroundHex);
	const lighter = Math.max(background, foreground);
	const darker = Math.min(background, foreground);
	return (lighter + .05) / (darker + .05);
}
function pickHigherContrastText(r, g, b) {
	const background = relativeLuminanceRgb(r, g, b);
	return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT);
}
function isLightBackground() {
	const explicit = normalizeOptionalLowercaseString(process.env.OPENCLAW_THEME);
	if (explicit === "light") return true;
	if (explicit === "dark") return false;
	const colorfgbg = process.env.COLORFGBG;
	if (colorfgbg && colorfgbg.length <= 64) {
		const sep = colorfgbg.lastIndexOf(";");
		const bg = Number.parseInt(sep >= 0 ? colorfgbg.slice(sep + 1) : colorfgbg, 10);
		if (bg >= 0 && bg <= 255) {
			if (bg <= 15) return bg === 7 || bg === 15;
			if (bg >= 232) return bg >= 244;
			const cubeIndex = bg - 16;
			const bVal = XTERM_LEVELS[cubeIndex % 6];
			const gVal = XTERM_LEVELS[Math.floor(cubeIndex / 6) % 6];
			const rVal = XTERM_LEVELS[Math.floor(cubeIndex / 36)];
			return pickHigherContrastText(rVal, gVal, bVal);
		}
	}
	return false;
}
const palette = isLightBackground() ? {
	text: "#1E1E1E",
	dim: "#5B6472",
	accent: "#B45309",
	accentSoft: "#C2410C",
	border: "#5B6472",
	userBg: "#F3F0E8",
	userText: "#1E1E1E",
	systemText: "#4B5563",
	toolPendingBg: "#EFF6FF",
	toolSuccessBg: "#ECFDF5",
	toolErrorBg: "#FEF2F2",
	toolTitle: "#B45309",
	toolOutput: "#374151",
	quote: "#1D4ED8",
	quoteBorder: "#2563EB",
	code: "#92400E",
	codeBlock: "#F9FAFB",
	codeBorder: "#92400E",
	link: "#047857",
	error: "#DC2626",
	success: "#047857"
} : {
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
/**
* Render code blocks with the theme code color without pulling a parser into the base TUI path.
* Returns an array of lines with ANSI escape codes.
*/
function highlightCode(code) {
	return code.split("\n").map((line) => fg(palette.code)(line));
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
		this.body = new HyperlinkMarkdown(text, 0, 0, markdownTheme, { color: (line) => theme.assistantText(line) });
		this.addChild(new Spacer(1));
		this.addChild(this.body);
	}
	setText(text) {
		this.body.setText(text);
	}
};
//#endregion
//#region src/tui/components/btw-inline-message.ts
var BtwInlineMessage = class extends Container {
	constructor(params) {
		super();
		this.setResult(params);
	}
	setResult(params) {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.header(`BTW: ${params.question}`), 1, 0));
		if (params.isError) this.addChild(new Text(theme.error(params.text), 1, 0));
		else this.addChild(new AssistantMessageComponent(params.text));
		this.addChild(new Text(theme.dim("Press Enter or Esc to dismiss"), 1, 0));
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
const EDGE_PUNCTUATION_RE = /^[`"'([{<]+|[`"')\]}>.,:;!?]+$/g;
const ALPHANUMERIC_RE = /[A-Za-z0-9]/;
const TOKENISH_MIN_LENGTH = 24;
const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const RTL_ISOLATE_START = "⁧";
const RTL_ISOLATE_END = "⁩";
const FENCED_CODE_RE = /(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*/g;
const INLINE_CODE_RE = /(`+)(?:(?!\1).)+?\1/g;
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
	const candidate = token.replace(EDGE_PUNCTUATION_RE, "") || token;
	if (URL_PREFIX_RE.test(candidate)) return true;
	if (candidate.startsWith("/") || candidate.startsWith("~/") || candidate.startsWith("./") || candidate.startsWith("../")) return true;
	if (WINDOWS_DRIVE_RE.test(candidate) || candidate.startsWith("\\\\")) return true;
	if (candidate.includes("/") || candidate.includes("\\")) return true;
	if (FILE_LIKE_RE.test(candidate) && (candidate.includes("_") || candidate.includes("-") || candidate.includes("."))) return true;
	if (candidate.length >= TOKENISH_MIN_LENGTH && /[a-z]/i.test(candidate) && /\d/.test(candidate)) return true;
	return false;
}
function normalizeLongTokenForDisplay(token) {
	if (isCopySensitiveToken(token)) return token;
	if (!ALPHANUMERIC_RE.test(token)) return token;
	return chunkToken(token, MAX_TOKEN_CHARS).join(" ");
}
function partitionByRegex(text, re) {
	const parts = [];
	let lastIndex = 0;
	for (const match of text.matchAll(re)) {
		const start = match.index ?? 0;
		if (start > lastIndex) parts.push({
			kind: "prose",
			text: text.slice(lastIndex, start)
		});
		parts.push({
			kind: "code",
			text: match[0]
		});
		lastIndex = start + match[0].length;
	}
	if (lastIndex < text.length) parts.push({
		kind: "prose",
		text: text.slice(lastIndex)
	});
	return parts;
}
function transformOutsideCode(text, transform) {
	return partitionByRegex(text, FENCED_CODE_RE).map((seg) => {
		if (seg.kind === "code") return seg.text;
		return partitionByRegex(seg.text, INLINE_CODE_RE).map((s) => s.kind === "code" ? s.text : transform(s.text)).join("");
	}).join("");
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
	return applyRtlIsolation(LONG_TOKEN_TEST_RE.test(redacted) ? transformOutsideCode(redacted, (segment) => LONG_TOKEN_TEST_RE.test(segment) ? segment.replace(LONG_TOKEN_RE, normalizeLongTokenForDisplay) : segment) : redacted);
}
function resolveFinalAssistantText(params) {
	const finalText = params.finalText ?? "";
	if (finalText.trim()) return finalText;
	const streamedText = params.streamedText ?? "";
	if (streamedText.trim()) return streamedText;
	const errorMessage = params.errorMessage ?? "";
	if (errorMessage.trim()) return formatRawAssistantErrorForUi(errorMessage);
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
	if (record.role === "assistant") {
		if (typeof content === "string") return sanitizeRenderableText(content).trim();
		if (Array.isArray(content)) return extractAssistantRenderableContent(record);
	}
	if (typeof content === "string") return sanitizeRenderableText(content).trim();
	const parts = collectSanitizedBlockStrings({
		content,
		blockType: "text",
		valueKey: "text"
	});
	if (parts.length > 0) return parts.join("\n").trim();
	return formatAssistantErrorFromRecord(record);
}
function extractAssistantRenderableContent(record) {
	const visible = sanitizeRenderableText(extractAssistantVisibleText(record) ?? "").trim();
	if (visible) return visible;
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
	if (record.role === "assistant") return composeThinkingAndContent({
		thinkingText: extractThinkingFromMessage(record),
		contentText: extractAssistantRenderableContent(record),
		showThinking: opts?.includeThinking ?? false
	});
	const text = extractTextBlocks(record.content, opts);
	if (text) {
		if (record.role === "user" || record.command === true) return stripLeadingInboundMetadata(text);
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
		this.body = new HyperlinkMarkdown(text, 0, y, markdownTheme, options);
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
const PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS = 6e4;
var ChatLog = class extends Container {
	constructor(maxComponents = 180) {
		super();
		this.toolById = /* @__PURE__ */ new Map();
		this.streamingRuns = /* @__PURE__ */ new Map();
		this.pendingUsers = /* @__PURE__ */ new Map();
		this.pendingSystemNotices = /* @__PURE__ */ new Map();
		this.btwMessage = null;
		this.toolsExpanded = false;
		this.repeatableSystemMessage = null;
		this.maxComponents = Math.max(20, Math.floor(maxComponents));
	}
	dropComponentReferences(component) {
		for (const [toolId, tool] of this.toolById.entries()) if (tool === component) this.toolById.delete(toolId);
		for (const [runId, message] of this.streamingRuns.entries()) if (message === component) this.streamingRuns.delete(runId);
		for (const [runId, entry] of this.pendingUsers.entries()) if (entry.component === component) this.pendingUsers.delete(runId);
		for (const [runId, entry] of this.pendingSystemNotices.entries()) if (entry === component) this.pendingSystemNotices.delete(runId);
		if (this.btwMessage === component) this.btwMessage = null;
		if (this.repeatableSystemMessage?.component === component) this.repeatableSystemMessage = null;
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
	appendNonSystem(component) {
		this.repeatableSystemMessage = null;
		this.append(component);
	}
	clearAll(opts) {
		this.clear();
		this.toolById.clear();
		this.streamingRuns.clear();
		this.pendingSystemNotices.clear();
		this.btwMessage = null;
		this.repeatableSystemMessage = null;
		if (!opts?.preservePendingUsers) this.pendingUsers.clear();
	}
	restorePendingUsers() {
		for (const entry of this.pendingUsers.values()) {
			if (this.children.includes(entry.component)) continue;
			this.appendNonSystem(entry.component);
		}
	}
	clearPendingUsers() {
		for (const entry of this.pendingUsers.values()) this.removeChild(entry.component);
		this.pendingUsers.clear();
	}
	formatRepeatedSystemText(text, count) {
		return count > 1 ? `${text} x${count}` : text;
	}
	createSystemMessage(text) {
		const entry = new Container();
		const textNode = new Text(theme.system(text), 1, 0);
		entry.addChild(new Spacer(1));
		entry.addChild(textNode);
		return {
			component: entry,
			textNode,
			baseText: text,
			count: 1
		};
	}
	addSystem(text, opts) {
		if (opts?.coalesceConsecutive && this.repeatableSystemMessage?.baseText === text && this.children[this.children.length - 1] === this.repeatableSystemMessage.component) {
			this.repeatableSystemMessage.count += 1;
			this.repeatableSystemMessage.textNode.setText(theme.system(this.formatRepeatedSystemText(text, this.repeatableSystemMessage.count)));
			return;
		}
		const message = this.createSystemMessage(text);
		this.append(message.component);
		this.repeatableSystemMessage = opts?.coalesceConsecutive ? message : null;
	}
	addPendingSystem(runId, text) {
		const existing = this.pendingSystemNotices.get(runId);
		if (existing) this.removeChild(existing);
		const message = this.createSystemMessage(text);
		this.pendingSystemNotices.set(runId, message.component);
		this.append(message.component);
	}
	dismissPendingSystem(runId) {
		const existing = this.pendingSystemNotices.get(runId);
		if (!existing) return false;
		this.removeChild(existing);
		this.pendingSystemNotices.delete(runId);
		return true;
	}
	addUser(text) {
		this.appendNonSystem(new UserMessageComponent(text));
	}
	addPendingUser(runId, text, createdAt = Date.now()) {
		const existing = this.pendingUsers.get(runId);
		if (existing) {
			existing.text = text;
			existing.createdAt = createdAt;
			existing.component.setText(text);
			return existing.component;
		}
		const component = new UserMessageComponent(text);
		this.pendingUsers.set(runId, {
			component,
			text,
			createdAt
		});
		this.appendNonSystem(component);
		return component;
	}
	commitPendingUser(runId) {
		return this.pendingUsers.delete(runId);
	}
	dropPendingUser(runId) {
		const existing = this.pendingUsers.get(runId);
		if (!existing) return false;
		this.removeChild(existing.component);
		this.pendingUsers.delete(runId);
		return true;
	}
	hasPendingUser(runId) {
		return this.pendingUsers.has(runId);
	}
	reconcilePendingUsers(historyUsers) {
		const normalizedHistory = historyUsers.map((entry) => ({
			text: entry.text.trim(),
			timestamp: typeof entry.timestamp === "number" ? entry.timestamp : null
		})).filter((entry) => entry.text.length > 0 && entry.timestamp !== null);
		const clearedRunIds = [];
		for (const [runId, entry] of this.pendingUsers.entries()) {
			const pendingText = entry.text.trim();
			if (!pendingText) continue;
			const matchIndex = normalizedHistory.findIndex((historyEntry) => historyEntry.text === pendingText && (historyEntry.timestamp ?? 0) >= entry.createdAt - PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS);
			if (matchIndex === -1) continue;
			if (this.children.includes(entry.component)) this.removeChild(entry.component);
			this.pendingUsers.delete(runId);
			clearedRunIds.push(runId);
			normalizedHistory.splice(matchIndex, 1);
		}
		return clearedRunIds;
	}
	countPendingUsers() {
		return this.pendingUsers.size;
	}
	resolveRunId(runId) {
		return runId ?? "default";
	}
	startAssistant(text, runId) {
		const effectiveRunId = this.resolveRunId(runId);
		const existing = this.streamingRuns.get(effectiveRunId);
		if (existing) {
			existing.setText(text);
			return existing;
		}
		const component = new AssistantMessageComponent(text);
		this.streamingRuns.set(effectiveRunId, component);
		this.appendNonSystem(component);
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
		this.appendNonSystem(new AssistantMessageComponent(text));
	}
	dropAssistant(runId) {
		const effectiveRunId = this.resolveRunId(runId);
		const existing = this.streamingRuns.get(effectiveRunId);
		if (!existing) return;
		this.removeChild(existing);
		this.streamingRuns.delete(effectiveRunId);
	}
	showBtw(params) {
		if (this.btwMessage) {
			this.btwMessage.setResult(params);
			if (this.children[this.children.length - 1] !== this.btwMessage) {
				this.removeChild(this.btwMessage);
				this.appendNonSystem(this.btwMessage);
			}
			return this.btwMessage;
		}
		const component = new BtwInlineMessage(params);
		this.btwMessage = component;
		this.appendNonSystem(component);
		return component;
	}
	dismissBtw() {
		if (!this.btwMessage) return;
		this.removeChild(this.btwMessage);
		this.btwMessage = null;
	}
	hasVisibleBtw() {
		return this.btwMessage !== null;
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
		this.appendNonSystem(component);
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
		if (matchesKey(data, Key.alt("up")) && this.onAltUp) {
			this.onAltUp();
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
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 6e4;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5e3;
function throwGatewayAuthResolutionError(reason) {
	throw new Error([
		reason,
		"Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
		"or resolve the configured secret provider for this credential."
	].join("\n"));
}
function isRetryableStartupUnavailable(err, method) {
	if (!(err instanceof GatewayClientRequestError)) return false;
	if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) return false;
	const details = err.details;
	if (!details || typeof details !== "object") return true;
	const detailMethod = details.method;
	return typeof detailMethod !== "string" || detailMethod === method;
}
function resolveStartupRetryDelayMs(err) {
	const retryAfterMs = typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
	return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
var GatewayChatClient = class GatewayChatClient {
	constructor(connection) {
		this.connection = connection;
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
		this.client = new GatewayClient({
			url: connection.url,
			token: connection.token,
			password: connection.password,
			preauthHandshakeTimeoutMs: connection.preauthHandshakeTimeoutMs,
			clientName: GATEWAY_CLIENT_NAMES.TUI,
			clientDisplayName: "openclaw-tui",
			clientVersion: VERSION,
			platform: process.platform,
			mode: GATEWAY_CLIENT_MODES.UI,
			deviceIdentity: connection.allowInsecureLocalOperatorUi ? null : void 0,
			caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
			instanceId: randomUUID(),
			minProtocol: 4,
			maxProtocol: 4,
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
	static async connect(opts) {
		return new GatewayChatClient(await resolveGatewayConnection(opts));
	}
	start() {
		startGatewayClientWhenEventLoopReady(this.client, { clientOptions: { preauthHandshakeTimeoutMs: this.connection.preauthHandshakeTimeoutMs } }).then((readiness) => {
			if (!readiness.ready && !readiness.aborted) this.onDisconnected?.("gateway event loop readiness timeout");
		}).catch((err) => {
			this.onDisconnected?.(err instanceof Error ? err.message : String(err));
		});
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
			...opts.sessionId ? { sessionId: opts.sessionId } : {},
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
		const startedAt = Date.now();
		for (;;) try {
			return await this.client.request("chat.history", {
				sessionKey: opts.sessionKey,
				limit: opts.limit
			});
		} catch (err) {
			if (Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS && isRetryableStartupUnavailable(err, "chat.history")) {
				await sleep(resolveStartupRetryDelayMs(err));
				continue;
			}
			throw err;
		}
	}
	async listSessions(opts) {
		return await this.client.request("sessions.list", opts ?? {});
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
	async getGatewayStatus() {
		return await this.client.request("status");
	}
	async listModels() {
		const res = await this.client.request("models.list");
		return Array.isArray(res?.models) ? res.models : [];
	}
	async listCommands(opts) {
		const res = await this.client.request("commands.list", opts ?? {});
		return Array.isArray(res?.commands) ? res.commands : [];
	}
};
async function resolveGatewayConnection(opts) {
	const config = getRuntimeConfig();
	const env = process.env;
	const gatewayAuthMode = config.gateway?.auth?.mode;
	const isRemoteMode = config.gateway?.mode === "remote";
	const preferConfiguredAuth = env[TUI_SETUP_AUTH_SOURCE_ENV] === TUI_SETUP_AUTH_SOURCE_CONFIG;
	const urlOverride = typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : void 0;
	const explicitAuth = resolveExplicitGatewayAuth({
		token: opts.token,
		password: opts.password
	});
	ensureExplicitGatewayAuth({
		urlOverride,
		urlOverrideSource: "cli",
		explicitAuth,
		errorHint: "Fix: pass --token or --password when using --url."
	});
	const url = buildGatewayConnectionDetails({
		config,
		...urlOverride ? { url: urlOverride } : {}
	}).url;
	const allowInsecureLocalOperatorUi = (() => {
		if (config.gateway?.controlUi?.allowInsecureAuth !== true) return false;
		try {
			return isLoopbackHost(new URL(url).hostname);
		} catch {
			return false;
		}
	})();
	if (urlOverride) return {
		url,
		token: explicitAuth.token,
		password: explicitAuth.password,
		preauthHandshakeTimeoutMs: config.gateway?.handshakeTimeoutMs,
		allowInsecureLocalOperatorUi
	};
	if (isRemoteMode) {
		const resolved = await resolveGatewayInteractiveSurfaceAuth({
			config,
			env,
			explicitAuth,
			surface: "remote"
		});
		if (resolved.failureReason) throwGatewayAuthResolutionError(resolved.failureReason);
		return {
			url,
			token: resolved.token,
			password: resolved.password,
			preauthHandshakeTimeoutMs: config.gateway?.handshakeTimeoutMs,
			allowInsecureLocalOperatorUi: false
		};
	}
	if (gatewayAuthMode === "none" || gatewayAuthMode === "trusted-proxy") {
		const resolved = await resolveGatewayInteractiveSurfaceAuth({
			config,
			env,
			explicitAuth,
			surface: "local"
		});
		return {
			url,
			token: resolved.token,
			password: resolved.password,
			preauthHandshakeTimeoutMs: config.gateway?.handshakeTimeoutMs,
			allowInsecureLocalOperatorUi
		};
	}
	try {
		assertExplicitGatewayAuthModeWhenBothConfigured(config);
	} catch (err) {
		throwGatewayAuthResolutionError(formatErrorMessage(err));
	}
	const resolved = await resolveGatewayInteractiveSurfaceAuth({
		config,
		env,
		explicitAuth,
		suppressEnvAuthFallback: preferConfiguredAuth,
		surface: "local"
	});
	if (resolved.failureReason) throwGatewayAuthResolutionError(resolved.failureReason);
	return {
		url,
		token: resolved.token,
		password: resolved.password,
		preauthHandshakeTimeoutMs: config.gateway?.handshakeTimeoutMs,
		allowInsecureLocalOperatorUi
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
	const textLower = normalizeLowercaseStringOrEmpty(text);
	const queryLower = normalizeLowercaseStringOrEmpty(query);
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
			searchTextLower: normalizeLowercaseStringOrEmpty(parts.join(" "))
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
		const queryLower = normalizeLowercaseStringOrEmpty(this.filterText);
		if (!queryLower.trim()) {
			this.selectList = new SelectList(this.allItems, this.maxVisible, this.theme);
			return;
		}
		const filtered = fuzzyFilterLower(this.allItems, queryLower);
		this.selectList = new SelectList(filtered, this.maxVisible, this.theme);
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
		if (matchesKey(keyData, "escape") || keyData === "") {
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
const ANSI_SGR_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
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
		const q = normalizeLowercaseStringOrEmpty(query);
		const scoredItems = [];
		const fuzzyCandidates = [];
		for (const item of this.items) {
			const rawLabel = this.getItemLabel(item);
			const rawDesc = item.description ?? "";
			const label = normalizeLowercaseStringOrEmpty(stripAnsi$1(rawLabel));
			const desc = normalizeLowercaseStringOrEmpty(stripAnsi$1(rawDesc));
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
				searchTextLower: normalizeLowercaseStringOrEmpty([
					rawLabel,
					rawDesc,
					searchText
				].map((value) => stripAnsi$1(value)).filter(Boolean).join(" "))
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
		const tokens = query.trim().split(/\s+/).map((token) => normalizeLowercaseStringOrEmpty(token)).filter((token) => token.length > 0);
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
		if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.notifySelectionChange();
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
			this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
			this.notifySelectionChange();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item && this.onSelect) this.onSelect(item);
			return;
		}
		if (matchesKey(keyData, "escape") || keyData === "") {
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
//#region src/tui/tui-session-list-policy.ts
const TUI_RECENT_SESSIONS_ACTIVE_MINUTES = 10080;
//#endregion
//#region src/tui/tui-status-summary.ts
function formatStatusSummary(summary) {
	const lines = [];
	lines.push("Gateway status");
	if (summary.runtimeVersion) lines.push(`Version: ${summary.runtimeVersion}`);
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
function isBtwCommand(text) {
	return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
}
function createCommandHandlers(context) {
	const { client, chatLog, tui, opts, state, deliverDefault, openOverlay, closeOverlay, refreshSessionInfo, loadHistory, setSession, refreshAgents, abortActive, setActivityStatus, formatSessionKey, applySessionInfoFromPatch, noteLocalBtwRunId, forgetLocalRunId, forgetLocalBtwRunId, runAuthFlow, requestExit } = context;
	const setAgent = async (id) => {
		state.currentAgentId = normalizeAgentId(id);
		await setSession("");
		chatLog.addSystem(`agent set to ${state.currentAgentId}; use /crestodian to return`);
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
			openSelector(createSearchableSelectList(models.map((model) => {
				const ref = modelKey(model.provider, model.id);
				return {
					value: ref,
					label: ref,
					description: model.name && model.name !== model.id ? model.name : ""
				};
			}), 9), async (value) => {
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
	const openContextModeSelector = () => {
		openSelector(createSearchableSelectList([
			{
				value: "list",
				label: "list",
				description: "Short context breakdown"
			},
			{
				value: "detail",
				label: "detail",
				description: "Per-file, per-tool, per-skill, and system prompt size"
			},
			{
				value: "json",
				label: "json",
				description: "Machine-readable context report"
			}
		], 9), async (value) => {
			await sendMessage(`/context ${value}`);
		});
	};
	const openSessionSelector = async () => {
		try {
			openSelector(createFilterableSelectList((await client.listSessions({
				limit: 50,
				activeMinutes: TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
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
					local: opts.local,
					provider: state.sessionInfo.modelProvider,
					model: state.sessionInfo.model
				}));
				break;
			case "auth": {
				if (!runAuthFlow) {
					chatLog.addSystem("auth login is only available in local embedded mode");
					break;
				}
				if (state.activeChatRunId || state.pendingOptimisticUserMessage) {
					chatLog.addSystem("abort the current run before /auth");
					break;
				}
				const provider = args.trim() || state.sessionInfo.modelProvider || void 0;
				chatLog.addSystem(provider ? `opening auth flow for ${provider}; TUI will resume when it exits` : "opening auth flow; TUI will resume when it exits");
				tui.requestRender();
				setActivityStatus("auth");
				try {
					const result = await runAuthFlow({ provider });
					await refreshSessionInfo();
					if (result.exitCode === 0 && !result.signal) {
						chatLog.addSystem(provider ? `auth flow finished for ${provider}` : "auth flow finished");
						setActivityStatus("idle");
					} else {
						const failureSuffix = result.signal ? ` (signal ${result.signal})` : typeof result.exitCode === "number" ? ` (exit ${String(result.exitCode)})` : "";
						chatLog.addSystem(`auth flow failed${failureSuffix}`);
						setActivityStatus("error");
					}
				} catch (err) {
					chatLog.addSystem(`auth flow failed: ${sanitizeRenderableText(String(err))}`);
					setActivityStatus("error");
				}
				break;
			}
			case "gateway-status":
				try {
					const status = await client.getGatewayStatus();
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
			case "context":
				if (!args) openContextModeSelector();
				else await sendMessage(raw);
				break;
			case "crestodian":
				chatLog.addSystem(args ? `returning to Crestodian with request: ${args}` : "returning to Crestodian");
				requestExit({
					exitReason: "return-to-crestodian",
					...args ? { crestodianMessage: args } : {}
				});
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
					const levels = state.sessionInfo.thinkingLevels?.map((level) => level.label).join("|") || formatThinkingLevels(state.sessionInfo.modelProvider, state.sessionInfo.model, "|");
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
			case "trace":
				if (!args) {
					chatLog.addSystem("usage: /trace <on|off>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						traceLevel: args
					});
					chatLog.addSystem(`trace set to ${args}`);
					applySessionInfoFromPatch(result);
					await loadHistory();
				} catch (err) {
					chatLog.addSystem(`trace failed: ${String(err)}`);
				}
				break;
			case "fast":
				if (!args || args === "status") {
					chatLog.addSystem(`fast mode: ${state.sessionInfo.fastMode ? "on" : "off"}`);
					break;
				}
				if (args !== "on" && args !== "off") {
					chatLog.addSystem("usage: /fast <status|on|off>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						fastMode: args === "on"
					});
					chatLog.addSystem(`fast mode ${args === "on" ? "enabled" : "disabled"}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`fast failed: ${String(err)}`);
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
			case "activation": {
				if (!args) {
					chatLog.addSystem("usage: /activation <mention|always>");
					break;
				}
				const activation = normalizeGroupActivation(args);
				if (!activation) {
					chatLog.addSystem("usage: /activation <mention|always>");
					break;
				}
				try {
					const result = await client.patchSession({
						key: state.currentSessionKey,
						groupActivation: activation
					});
					chatLog.addSystem(`activation set to ${activation}`);
					applySessionInfoFromPatch(result);
					await refreshSessionInfo();
				} catch (err) {
					chatLog.addSystem(`activation failed: ${String(err)}`);
				}
				break;
			}
			case "new":
				try {
					state.sessionInfo.inputTokens = null;
					state.sessionInfo.outputTokens = null;
					state.sessionInfo.totalTokens = null;
					tui.requestRender();
					const uniqueKey = `tui-${randomUUID()}`;
					await setSession(uniqueKey);
					chatLog.addSystem(`new session: ${uniqueKey}`);
				} catch (err) {
					chatLog.addSystem(`new session failed: ${sanitizeRenderableText(String(err))}`);
				}
				break;
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
					chatLog.addSystem(`reset failed: ${sanitizeRenderableText(String(err))}`);
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
			chatLog.addSystem(opts.local ? "local runtime not ready — message not sent" : "not connected to gateway — message not sent");
			setActivityStatus("disconnected");
			tui.requestRender();
			return;
		}
		const isBtw = isBtwCommand(text);
		const canQueueBehindLocalFinishingTurn = opts.local === true && state.activityStatus === "finishing context";
		if (!isBtw && (!canQueueBehindLocalFinishingTurn || state.pendingChatRunId || state.pendingOptimisticUserMessage) && (state.activeChatRunId || state.pendingChatRunId || state.pendingOptimisticUserMessage)) {
			chatLog.addSystem("agent is busy — press Esc to abort before sending a new message");
			tui.requestRender();
			return;
		}
		const runId = randomUUID();
		try {
			if (!isBtw) {
				chatLog.addUser(text);
				state.pendingOptimisticUserMessage = true;
				setActivityStatus("sending");
			} else noteLocalBtwRunId?.(runId);
			tui.requestRender();
			await client.sendChat({
				sessionKey: state.currentSessionKey,
				sessionId: state.currentSessionId,
				message: text,
				thinking: opts.thinking,
				deliver: deliverDefault,
				timeoutMs: opts.timeoutMs,
				runId
			});
			if (!isBtw) {
				state.pendingChatRunId = runId;
				setActivityStatus("waiting");
				tui.requestRender();
			}
		} catch (err) {
			if (isBtw) forgetLocalBtwRunId?.(runId);
			if (!isBtw && state.activeChatRunId) forgetLocalRunId?.(state.activeChatRunId);
			if (!isBtw) {
				state.pendingOptimisticUserMessage = false;
				state.pendingChatRunId = null;
				state.activeChatRunId = null;
			}
			chatLog.addSystem(`${isBtw ? "btw failed" : "send failed"}: ${String(err)}`);
			if (!isBtw) setActivityStatus("error");
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
	finalize(runId, message, showThinking, errorMessage) {
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
			streamedText: streamedDisplayText,
			errorMessage
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
const DEFAULT_STREAMING_WATCHDOG_MS = 3e4;
const STREAMING_WATCHDOG_USER_MESSAGE = "This response is taking longer than expected. Send another message to continue.";
function createEventHandlers(context) {
	const { chatLog, btw, tui, state, setActivityStatus, refreshSessionInfo, loadHistory, noteLocalRunId, isLocalRunId, forgetLocalRunId, clearLocalRunIds, isLocalBtwRunId, forgetLocalBtwRunId, clearLocalBtwRunIds, localMode } = context;
	const finalizedRuns = /* @__PURE__ */ new Map();
	const sessionRuns = /* @__PURE__ */ new Map();
	const postFinalizingRuns = /* @__PURE__ */ new Map();
	let streamAssembler = new TuiStreamAssembler();
	let lastSessionKey = state.currentSessionKey;
	let pendingHistoryRefresh = false;
	let reconnectPendingRunId = null;
	const streamingWatchdogMs = typeof context.streamingWatchdogMs === "number" && Number.isFinite(context.streamingWatchdogMs) && context.streamingWatchdogMs >= 0 ? Math.floor(context.streamingWatchdogMs) : DEFAULT_STREAMING_WATCHDOG_MS;
	let streamingWatchdogTimer = null;
	let streamingWatchdogRunId = null;
	const flushPendingHistoryRefreshIfIdle = () => {
		if (!pendingHistoryRefresh || state.activeChatRunId) return;
		pendingHistoryRefresh = false;
		loadHistory?.();
	};
	const clearStreamingWatchdog = () => {
		if (streamingWatchdogTimer) {
			clearTimeout(streamingWatchdogTimer);
			streamingWatchdogTimer = null;
		}
		streamingWatchdogRunId = null;
	};
	const pauseStreamingWatchdog = () => {
		clearStreamingWatchdog();
	};
	const armStreamingWatchdog = (runId) => {
		if (streamingWatchdogMs <= 0) return;
		if (streamingWatchdogTimer) clearTimeout(streamingWatchdogTimer);
		streamingWatchdogRunId = runId;
		streamingWatchdogTimer = setTimeout(() => {
			streamingWatchdogTimer = null;
			if (streamingWatchdogRunId !== runId || state.activeChatRunId !== runId) return;
			streamingWatchdogRunId = null;
			state.activeChatRunId = null;
			state.activityStatus = "idle";
			setActivityStatus("idle");
			if (reconnectPendingRunId === runId) {
				reconnectPendingRunId = null;
				pendingHistoryRefresh = false;
				loadHistory?.();
				tui.requestRender();
				return;
			}
			flushPendingHistoryRefreshIfIdle();
			chatLog.addPendingSystem(runId, STREAMING_WATCHDOG_USER_MESSAGE);
			tui.requestRender();
		}, streamingWatchdogMs);
		const maybeUnref = streamingWatchdogTimer.unref;
		if (typeof maybeUnref === "function") maybeUnref.call(streamingWatchdogTimer);
	};
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
		postFinalizingRuns.clear();
		streamAssembler = new TuiStreamAssembler();
		pendingHistoryRefresh = false;
		state.pendingOptimisticUserMessage = false;
		state.pendingChatRunId = null;
		reconnectPendingRunId = null;
		clearLocalRunIds?.();
		clearLocalBtwRunIds?.();
		btw.clear();
		clearStreamingWatchdog();
	};
	const resolveAuthErrorHint = (errorMessage) => {
		if (!localMode || !isAuthErrorMessage(errorMessage)) return;
		const provider = state.sessionInfo.modelProvider?.trim();
		return provider ? `auth or provider access failed for ${provider}. Run /auth ${provider} to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.` : "auth or provider access failed for the current provider. Run /auth to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.";
	};
	const parseProviderModelRef = (modelRef) => {
		if (typeof modelRef !== "string") return;
		const trimmed = modelRef.trim();
		const separator = trimmed.indexOf("/");
		if (separator <= 0 || separator >= trimmed.length - 1) return;
		const provider = trimmed.slice(0, separator).trim();
		const model = trimmed.slice(separator + 1).trim();
		return provider && model ? {
			provider,
			model
		} : void 0;
	};
	const applyFallbackStepModelUpdate = (evt) => {
		const data = evt.data ?? {};
		if (evt.stream !== "lifecycle" || asString(data.phase, "") !== "fallback_step") return false;
		const target = parseProviderModelRef(data.fallbackStepToModel);
		if (!target) return false;
		state.sessionInfo.modelProvider = target.provider;
		state.sessionInfo.model = target.model;
		return true;
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
	const notePostFinalizingRun = (runId) => {
		postFinalizingRuns.set(runId, Date.now());
		pruneRunMap(postFinalizingRuns);
	};
	const clearActiveRunIfMatch = (runId) => {
		if (state.activeChatRunId === runId) state.activeChatRunId = null;
	};
	const clearStaleStreamingIfNoTrackedRunRemains = () => {
		const activeRunId = state.activeChatRunId;
		const activeRunIsStillTracked = activeRunId ? sessionRuns.has(activeRunId) : false;
		if (state.activityStatus !== "streaming" || activeRunIsStillTracked || sessionRuns.size > 0) return;
		state.activeChatRunId = null;
		state.activityStatus = "idle";
		setActivityStatus("idle");
		clearStreamingWatchdog();
		flushPendingHistoryRefreshIfIdle();
	};
	const reconnectStreamingWatchdog = () => {
		clearStreamingWatchdog();
		const activeRunId = state.activeChatRunId;
		if (!activeRunId) {
			reconnectPendingRunId = null;
			clearStaleStreamingIfNoTrackedRunRemains();
			return;
		}
		if (!sessionRuns.has(activeRunId)) {
			reconnectPendingRunId = null;
			state.activeChatRunId = null;
			state.activityStatus = "idle";
			setActivityStatus("idle");
			flushPendingHistoryRefreshIfIdle();
			return;
		}
		reconnectPendingRunId = activeRunId;
		setActivityStatus("streaming");
		armStreamingWatchdog(activeRunId);
	};
	const finalizeRun = (params) => {
		noteFinalizedRun(params.runId);
		clearActiveRunIfMatch(params.runId);
		flushPendingHistoryRefreshIfIdle();
		if (params.wasActiveRun) {
			setActivityStatus(params.status);
			clearStreamingWatchdog();
		} else {
			if (streamingWatchdogRunId === params.runId) clearStreamingWatchdog();
			clearStaleStreamingIfNoTrackedRunRemains();
		}
		refreshSessionInfo?.();
	};
	const terminateRun = (params) => {
		streamAssembler.drop(params.runId);
		sessionRuns.delete(params.runId);
		clearActiveRunIfMatch(params.runId);
		flushPendingHistoryRefreshIfIdle();
		if (params.wasActiveRun) {
			setActivityStatus(params.status);
			clearStreamingWatchdog();
		} else if (streamingWatchdogRunId === params.runId) clearStreamingWatchdog();
		refreshSessionInfo?.();
	};
	const hasConcurrentActiveRun = (runId) => {
		const activeRunId = state.activeChatRunId;
		if (!activeRunId || activeRunId === runId) return false;
		return sessionRuns.has(activeRunId);
	};
	const maybeRefreshHistoryForRun = (runId, opts) => {
		if (isLocalRunId?.(runId) ?? false) {
			forgetLocalRunId?.(runId);
			if (!opts?.allowLocalWithoutDisplayableFinal) return;
			if (state.activeChatRunId && state.activeChatRunId !== runId) {
				pendingHistoryRefresh = true;
				return;
			}
		}
		if (hasConcurrentActiveRun(runId)) return;
		pendingHistoryRefresh = false;
		loadHistory?.();
	};
	const isSameSessionKey = (left, right) => {
		const normalizedLeft = normalizeLowercaseStringOrEmpty(left);
		const normalizedRight = normalizeLowercaseStringOrEmpty(right);
		if (!normalizedLeft || !normalizedRight) return false;
		if (normalizedLeft === normalizedRight) return true;
		const parsedLeft = parseAgentSessionKey(normalizedLeft);
		const parsedRight = parseAgentSessionKey(normalizedRight);
		if (parsedLeft && parsedRight) return parsedLeft.agentId === parsedRight.agentId && parsedLeft.rest === parsedRight.rest;
		if (parsedLeft) return parsedLeft.rest === normalizedRight;
		if (parsedRight) return normalizedLeft === parsedRight.rest;
		return false;
	};
	const handleChatEvent = (payload) => {
		if (!payload || typeof payload !== "object") return;
		const evt = payload;
		syncSessionKey();
		if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) return;
		if (finalizedRuns.has(evt.runId)) {
			if (evt.state === "delta") return;
			if (evt.state === "final") {
				clearStaleStreamingIfNoTrackedRunRemains();
				return;
			}
		}
		if (reconnectPendingRunId === evt.runId) reconnectPendingRunId = null;
		chatLog.dismissPendingSystem(evt.runId);
		noteSessionRun(evt.runId);
		if (!state.activeChatRunId && !isLocalBtwRunId?.(evt.runId)) {
			state.activeChatRunId = evt.runId;
			if (state.pendingOptimisticUserMessage) {
				noteLocalRunId?.(evt.runId);
				state.pendingOptimisticUserMessage = false;
			}
		}
		if (state.pendingChatRunId === evt.runId) state.pendingChatRunId = null;
		if (evt.state === "delta") {
			setActivityStatus("streaming");
			if (state.activeChatRunId === evt.runId) armStreamingWatchdog(evt.runId);
			const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
			if (!displayText) return;
			chatLog.updateAssistant(displayText, evt.runId);
		}
		if (evt.state === "final") {
			const isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
			const wasActiveRun = state.activeChatRunId === evt.runId;
			if (!evt.message && isLocalBtwRun) {
				forgetLocalBtwRunId?.(evt.runId);
				noteFinalizedRun(evt.runId);
				clearStaleStreamingIfNoTrackedRunRemains();
				tui.requestRender();
				return;
			}
			if (!evt.message) {
				maybeRefreshHistoryForRun(evt.runId, { allowLocalWithoutDisplayableFinal: true });
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
			const finalText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking, evt.errorMessage);
			if (finalText === "(no output)" && !isLocalRunId?.(evt.runId)) chatLog.dropAssistant(evt.runId);
			else chatLog.finalizeAssistant(finalText, evt.runId);
			finalizeRun({
				runId: evt.runId,
				wasActiveRun,
				status: stopReason === "error" ? "error" : "idle"
			});
		}
		if (evt.state === "aborted") {
			forgetLocalBtwRunId?.(evt.runId);
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
			forgetLocalBtwRunId?.(evt.runId);
			const wasActiveRun = state.activeChatRunId === evt.runId;
			const errorMessage = evt.errorMessage ?? "unknown";
			const renderedError = formatRawAssistantErrorForUi(errorMessage);
			chatLog.addSystem(resolveAuthErrorHint(errorMessage) ?? `run error: ${renderedError}`);
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
		const isPendingRun = evt.runId === state.pendingChatRunId;
		const isSessionRun = sessionRuns.has(evt.runId);
		if ((isActiveRun || isPendingRun || isSessionRun) && applyFallbackStepModelUpdate(evt)) {
			if (isActiveRun) armStreamingWatchdog(evt.runId);
			tui.requestRender();
			return;
		}
		if (!(isActiveRun || isPendingRun || isSessionRun || finalizedRuns.has(evt.runId))) return;
		if (evt.stream === "tool") {
			if (isActiveRun) armStreamingWatchdog(evt.runId);
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
			if (isPendingRun) {
				noteSessionRun(evt.runId);
				state.activeChatRunId = evt.runId;
				state.pendingChatRunId = null;
				if (state.pendingOptimisticUserMessage) {
					if (localMode) noteLocalRunId?.(evt.runId);
					state.pendingOptimisticUserMessage = false;
				}
			}
			const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
			const isPostFinalTerminalPhase = postFinalizingRuns.has(evt.runId) && (phase === "end" || phase === "error");
			if (!isActiveRun && !isPendingRun && phase !== "finishing" && !isPostFinalTerminalPhase) return;
			const canUpdateActivityStatus = !hasConcurrentActiveRun(evt.runId);
			if (phase && phase !== "end" && phase !== "error" && phase !== "finishing") armStreamingWatchdog(evt.runId);
			if (phase === "start") {
				if (!canUpdateActivityStatus) return;
				setActivityStatus("running");
			}
			if (phase === "finishing") {
				notePostFinalizingRun(evt.runId);
				if (!canUpdateActivityStatus) return;
				clearStreamingWatchdog();
				setActivityStatus("finishing context");
			}
			if (phase === "end") {
				postFinalizingRuns.delete(evt.runId);
				if (!canUpdateActivityStatus) return;
				setActivityStatus("idle");
			}
			if (phase === "error") {
				postFinalizingRuns.delete(evt.runId);
				if (!canUpdateActivityStatus) return;
				setActivityStatus("error");
			}
			tui.requestRender();
		}
	};
	const handleBtwEvent = (payload) => {
		if (!payload || typeof payload !== "object") return;
		const evt = payload;
		syncSessionKey();
		if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) return;
		if (evt.kind !== "btw") return;
		const question = evt.question.trim();
		const text = evt.text.trim();
		if (!question || !text) return;
		btw.showResult({
			question,
			text,
			isError: evt.isError
		});
		tui.requestRender();
	};
	const dispose = () => {
		clearStreamingWatchdog();
	};
	return {
		handleChatEvent,
		handleAgentEvent,
		handleBtwEvent,
		pauseStreamingWatchdog,
		reconnectStreamingWatchdog,
		dispose
	};
}
//#endregion
//#region src/tui/tui-last-session.ts
function resolveTuiLastSessionStatePath(stateDir = resolveStateDir()) {
	return path.join(stateDir, "tui", "last-session.json");
}
function buildTuiLastSessionScopeKey(params) {
	const agentId = normalizeAgentId(params.agentId);
	const connectionUrl = params.connectionUrl.trim() || "local";
	return createHash("sha256").update(`${params.sessionScope}\n${agentId}\n${connectionUrl}`).digest("hex").slice(0, 32);
}
async function readStore(filePath) {
	try {
		const parsed = await privateFileStore(path.dirname(filePath)).readJsonIfExists(path.basename(filePath));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
function normalizeMarker(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function isHeartbeatSessionKey(sessionKey) {
	return normalizeMarker(sessionKey).endsWith(":heartbeat");
}
function isHeartbeatLikeTuiSession(session) {
	if (isHeartbeatSessionKey(session.key)) return true;
	return [
		session.provider,
		session.lastProvider,
		session.lastChannel,
		session.lastTo,
		session.origin?.provider,
		session.origin?.surface,
		session.origin?.label
	].some((marker) => normalizeMarker(marker) === "heartbeat");
}
async function readTuiLastSessionKey(params) {
	const value = (await readStore(resolveTuiLastSessionStatePath(params.stateDir)))[params.scopeKey]?.sessionKey;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
async function writeTuiLastSessionKey(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey || sessionKey === "unknown" || isHeartbeatSessionKey(sessionKey)) return;
	const filePath = resolveTuiLastSessionStatePath(params.stateDir);
	const store = await readStore(filePath);
	store[params.scopeKey] = {
		sessionKey,
		updatedAt: Date.now()
	};
	await privateFileStore(path.dirname(filePath)).writeJson(path.basename(filePath), store, { trailingNewline: true });
}
function resolveRememberedTuiSessionKey(params) {
	const rememberedKey = params.rememberedKey?.trim();
	if (!rememberedKey) return null;
	if (isHeartbeatSessionKey(rememberedKey)) return null;
	const currentAgentId = normalizeAgentId(params.currentAgentId);
	const parsed = parseAgentSessionKey(rememberedKey);
	if (parsed && normalizeAgentId(parsed.agentId) !== currentAgentId) return null;
	const rememberedRest = parsed?.rest ?? rememberedKey;
	return params.sessions.find((session) => {
		if (isHeartbeatLikeTuiSession(session)) return false;
		if (session.key === rememberedKey) return true;
		return parseAgentSessionKey(session.key)?.rest === rememberedRest;
	})?.key ?? null;
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
				env: {
					...env,
					OPENCLAW_SHELL: "tui-local"
				}
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
				deps.chatLog.addSystem(`[local] exit ${code ?? "?"}${signal ? ` (signal ${signal})` : ""}`);
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
	const { client, chatLog, btw, tui, opts, state, agentNames, initialSessionInput, initialSessionAgentId, resolveSessionKey, updateHeader, updateFooter, updateAutocompleteProvider, setActivityStatus, clearLocalRunIds, rememberSessionKey } = context;
	let refreshSessionInfoPromise = Promise.resolve();
	let lastSessionDefaults = null;
	const applyAgentsResult = (result) => {
		state.agentDefaultId = normalizeAgentId(result.defaultId);
		state.sessionMainKey = normalizeMainKey(result.mainKey);
		state.sessionScope = result.scope ?? state.sessionScope;
		state.agents = result.agents.map((agent) => ({
			id: normalizeAgentId(agent.id),
			name: normalizeOptionalString(agent.name)
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
		return resolveSessionInfoModelSelection({
			currentProvider: state.sessionInfo.modelProvider,
			currentModel: state.sessionInfo.model,
			defaultProvider: lastSessionDefaults?.modelProvider,
			defaultModel: lastSessionDefaults?.model,
			entryProvider: entry?.modelProvider,
			entryModel: entry?.model,
			overrideProvider: entry?.providerOverride,
			overrideModel: entry?.modelOverride
		});
	};
	const applySessionInfo = (params) => {
		const entry = params.entry ?? void 0;
		const defaults = params.defaults ?? lastSessionDefaults ?? void 0;
		const previousDefaults = lastSessionDefaults;
		const defaultsChanged = params.defaults ? previousDefaults?.model !== params.defaults.model || previousDefaults?.modelProvider !== params.defaults.modelProvider || previousDefaults?.contextTokens !== params.defaults.contextTokens : false;
		if (params.defaults) lastSessionDefaults = params.defaults;
		const entryUpdatedAt = entry?.updatedAt ?? null;
		const currentUpdatedAt = state.sessionInfo.updatedAt ?? null;
		if (!params.force && entryUpdatedAt !== null && currentUpdatedAt !== null && entryUpdatedAt < currentUpdatedAt && !defaultsChanged) return;
		const next = { ...state.sessionInfo };
		if (entry?.thinkingLevel !== void 0) next.thinkingLevel = entry.thinkingLevel;
		if (entry?.thinkingLevels !== void 0 || defaults?.thinkingLevels !== void 0) next.thinkingLevels = entry?.thinkingLevels ?? defaults?.thinkingLevels;
		if (entry?.fastMode !== void 0) next.fastMode = entry.fastMode;
		if (entry?.verboseLevel !== void 0) next.verboseLevel = entry.verboseLevel;
		if (entry?.traceLevel !== void 0) next.traceLevel = entry.traceLevel;
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
				limit: 5,
				search: state.currentSessionKey,
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
			state.sessionInfo.fastMode = record.fastMode ?? state.sessionInfo.fastMode;
			state.sessionInfo.verboseLevel = record.verboseLevel ?? state.sessionInfo.verboseLevel;
			state.sessionInfo.traceLevel = record.traceLevel ?? state.sessionInfo.traceLevel;
			const showTools = (state.sessionInfo.verboseLevel ?? "off") !== "off";
			chatLog.clearAll();
			btw.clear();
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
			rememberSessionKey?.(state.currentSessionKey);
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
		state.pendingChatRunId = null;
		setActivityStatus("idle");
		state.currentSessionId = null;
		state.sessionInfo.updatedAt = null;
		state.historyLoaded = false;
		clearLocalRunIds?.();
		btw.clear();
		updateHeader();
		updateFooter();
		await loadHistory();
	};
	const abortActive = async () => {
		if (opts.local === true && state.activityStatus === "finishing context" && !state.pendingChatRunId) {
			chatLog.addSystem("agent is finishing context; wait for it to finish before aborting");
			tui.requestRender();
			return;
		}
		const runId = opts.local === true && state.activeChatRunId && state.pendingChatRunId ? state.pendingChatRunId : state.activeChatRunId ?? state.pendingChatRunId ?? null;
		if (!runId) {
			chatLog.addSystem("no active run", { coalesceConsecutive: true });
			tui.requestRender();
			return;
		}
		try {
			await client.abortChat({
				sessionKey: state.currentSessionKey,
				runId
			});
			state.pendingChatRunId = null;
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
//#region src/tui/tui-submit.ts
function createEditorSubmitHandler(params) {
	return (text) => {
		const raw = text;
		const value = raw.trim();
		if (!value) {
			params.editor.setText("");
			return;
		}
		if (raw.startsWith("!") && raw !== "!") {
			params.editor.setText("");
			params.editor.addToHistory(raw);
			params.handleBangLine(raw);
			return;
		}
		if (value.startsWith("/")) {
			params.editor.setText("");
			params.editor.addToHistory(value);
			params.handleCommand(value);
			return;
		}
		if (params.canSubmitMessage && !params.canSubmitMessage()) {
			params.editor.setText(value);
			params.onBlockedMessageSubmit?.(value);
			return;
		}
		params.editor.setText("");
		params.editor.addToHistory(value);
		params.sendMessage(value);
	};
}
function shouldEnableWindowsGitBashPasteFallback(params) {
	const platform = params?.platform ?? process.platform;
	const env = params?.env ?? process.env;
	const termProgram = normalizeLowercaseStringOrEmpty(env.TERM_PROGRAM);
	if (platform === "darwin") {
		if (termProgram.includes("iterm") || termProgram.includes("apple_terminal")) return true;
		return false;
	}
	if (platform !== "win32") return false;
	const msystem = (env.MSYSTEM ?? "").toUpperCase();
	const shell = env.SHELL ?? "";
	if (msystem.startsWith("MINGW") || msystem.startsWith("MSYS")) return true;
	if (normalizeLowercaseStringOrEmpty(shell).includes("bash")) return true;
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
const OPENCLAW_CLI_WRAPPER_PATH = fileURLToPath(new URL("../../openclaw.mjs", import.meta.url));
const OPENCLAW_RUN_NODE_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/run-node.mjs", import.meta.url));
const OPENCLAW_DIST_ENTRY_JS_PATH = fileURLToPath(new URL("../../dist/entry.js", import.meta.url));
const OPENCLAW_DIST_ENTRY_MJS_PATH = fileURLToPath(new URL("../../dist/entry.mjs", import.meta.url));
const OPENAI_CODEX_PROVIDER = "openai-codex";
/** Resolve the absolute path to the `codex` CLI binary, or `null` if not installed. */
function resolveCodexCliBin() {
	try {
		return execFileSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" }).trim().split(/\r?\n/)[0] || null;
	} catch {
		return null;
	}
}
function resolveLocalAuthCliInvocation(params) {
	const hasDistEntry = params?.hasDistEntry ?? (existsSync(OPENCLAW_DIST_ENTRY_JS_PATH) || existsSync(OPENCLAW_DIST_ENTRY_MJS_PATH));
	const hasRunNodeScript = params?.hasRunNodeScript ?? existsSync(OPENCLAW_RUN_NODE_SCRIPT_PATH);
	const command = params?.execPath ?? process.execPath;
	const wrapperPath = params?.wrapperPath ?? OPENCLAW_CLI_WRAPPER_PATH;
	const runNodePath = params?.runNodePath ?? OPENCLAW_RUN_NODE_SCRIPT_PATH;
	return hasDistEntry || !hasRunNodeScript ? {
		command,
		args: [
			wrapperPath,
			"models",
			"auth",
			"login"
		]
	} : {
		command,
		args: [
			runNodePath,
			"models",
			"auth",
			"login"
		]
	};
}
function resolveLocalAuthSpawnOptions(params) {
	return (params.platform ?? process.platform) === "win32" && /\.(cmd|bat)$/iu.test(params.command.trim()) ? { shell: true } : {};
}
function resolveLocalAuthSpawnCwd(params) {
	const defaultCwd = params.defaultCwd ?? process.cwd();
	const entryArg = params.args[0]?.trim();
	if (!entryArg) return defaultCwd;
	const entryBase = path.basename(entryArg).toLowerCase();
	if (entryBase === "openclaw.mjs") return path.dirname(entryArg);
	if (entryBase === "run-node.mjs") return path.dirname(path.dirname(entryArg));
	return defaultCwd;
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
	if (trimmed.startsWith("agent:")) return normalizeLowercaseStringOrEmpty(trimmed);
	return `agent:${params.currentAgentId}:${normalizeLowercaseStringOrEmpty(trimmed)}`;
}
function resolveInitialTuiAgentId(params) {
	const parsed = parseAgentSessionKey((params.initialSessionInput ?? "").trim());
	if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
	const inferredFromWorkspace = resolveAgentIdByWorkspacePath(params.cfg, params.cwd ?? process.cwd());
	if (inferredFromWorkspace) return inferredFromWorkspace;
	return normalizeAgentId(params.fallbackAgentId);
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
		if (data !== "\b" && !matchesKey(data, Key.backspace)) return data;
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
function isTuiTerminalLossError(error) {
	if (!error || typeof error !== "object") return false;
	const err = error;
	const code = typeof err.code === "string" ? err.code : "";
	const message = typeof err.message === "string" ? err.message : "";
	const syscall = typeof err.syscall === "string" ? err.syscall : "";
	if (code === "EIO" || code === "EPIPE") return true;
	return /\b(EIO|EPIPE)\b/i.test(message) && /\b(read|write|TTY|stdin|stdout)\b/i.test(message + syscall);
}
function installTuiTerminalLossExitHandler(requestExit, targets = {
	stdin: process.stdin,
	stdout: process.stdout
}) {
	let requested = false;
	const requestOnce = () => {
		if (requested) return;
		requested = true;
		requestExit();
	};
	const removeUncaughtExceptionHandler = registerUncaughtExceptionHandler((error) => {
		if (!isTuiTerminalLossError(error)) return false;
		requestOnce();
		return true;
	});
	const onClose = () => requestOnce();
	targets.stdin?.on("end", onClose);
	targets.stdin?.on("close", onClose);
	targets.stdout?.on("close", onClose);
	return () => {
		removeUncaughtExceptionHandler();
		targets.stdin?.off("end", onClose);
		targets.stdin?.off("close", onClose);
		targets.stdout?.off("close", onClose);
	};
}
function createDeferredTuiFinish() {
	let finishTui = null;
	let finishRequested = false;
	return {
		requestFinish: () => {
			const finish = finishTui;
			if (finish) {
				finish();
				return;
			}
			finishRequested = true;
		},
		setFinish: (finish) => {
			finishTui = finish;
			if (finishRequested) finish();
		},
		clearFinish: () => {
			finishTui = null;
		}
	};
}
const TUI_SHUTDOWN_DRAIN_MAX_MS = 500;
const TUI_SHUTDOWN_DRAIN_IDLE_MS = 100;
const TUI_SHUTDOWN_HARD_EXIT_MS = 2e3;
const TUI_PROCESS_EXIT_AFTER_RETURN_MS = 2e3;
async function drainAndStopTuiSafely(tui) {
	if (typeof tui.terminal?.drainInput === "function") try {
		await tui.terminal.drainInput(TUI_SHUTDOWN_DRAIN_MAX_MS, TUI_SHUTDOWN_DRAIN_IDLE_MS);
	} catch {}
	stopTuiSafely(() => tui.stop());
}
function canSubmitTuiChatMessage(params) {
	const pending = Boolean(params.pendingChatRunId) || params.pendingOptimisticUserMessage === true;
	if (params.activeChatRunId) return params.local === true && params.activityStatus === "finishing context" && !pending;
	return !pending;
}
const TUI_BUSY_ACTIVITY_STATUSES = new Set([
	"sending",
	"waiting",
	"streaming",
	"running",
	"finishing context"
]);
function isTuiBusyActivityStatus(status) {
	return TUI_BUSY_ACTIVITY_STATUSES.has(status);
}
function resolveTuiShutdownHardExitMs(params = {}) {
	return TUI_SHUTDOWN_HARD_EXIT_MS + (params.localMode ? resolveLocalRunShutdownGraceMs() : 0);
}
function scheduleProcessExitAfterTuiReturn(params = {}) {
	const delayMs = Math.max(0, Math.floor(params.delayMs ?? TUI_PROCESS_EXIT_AFTER_RETURN_MS));
	const setTimeoutFn = params.setTimeoutFn ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
	const exit = params.exit ?? ((code) => process.exit(code));
	const writeStderr = params.writeStderr ?? ((text) => {
		process.stderr.write(text);
	});
	const timer = setTimeoutFn(() => {
		try {
			writeStderr("openclaw tui forcing process exit after return\n");
		} catch {}
		exit(0);
	}, delayMs);
	timer.unref?.();
	return timer;
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
function resolveTuiCtrlCAction(params) {
	if (params.exitRequested === true) return {
		action: "force-exit",
		nextLastCtrlCAt: params.lastCtrlCAt
	};
	if (params.wasDisconnected === true) return {
		action: "exit",
		nextLastCtrlCAt: params.lastCtrlCAt
	};
	return resolveCtrlCAction(params);
}
async function runTui(opts) {
	const isLocalMode = opts.local === true || opts.backend !== void 0;
	const config = opts.config ?? getRuntimeConfig({ skipPluginValidation: !isLocalMode });
	const initialSessionInput = (opts.session ?? "").trim();
	let sessionScope = config.session?.scope ?? "per-sender";
	let sessionMainKey = normalizeMainKey(config.session?.mainKey);
	let agentDefaultId = resolveDefaultAgentId(config);
	let currentAgentId = resolveInitialTuiAgentId({
		cfg: config,
		fallbackAgentId: agentDefaultId,
		initialSessionInput,
		cwd: process.cwd()
	});
	let agents = [];
	const agentNames = /* @__PURE__ */ new Map();
	let currentSessionKey = "";
	let initialSessionApplied = false;
	let rememberedSessionApplied = false;
	let currentSessionId = null;
	let activeChatRunId = null;
	let pendingOptimisticUserMessage = false;
	let pendingChatRunId = null;
	let historyLoaded = false;
	let isConnected = false;
	let wasDisconnected = false;
	let toolsExpanded = false;
	let showThinking = false;
	let pairingHintShown = false;
	const localRunIds = /* @__PURE__ */ new Set();
	const localBtwRunIds = /* @__PURE__ */ new Set();
	const deliverDefault = opts.deliver ?? false;
	const autoMessage = opts.message?.trim();
	let autoMessageSent = false;
	let sessionInfo = {};
	let dynamicSlashCommands = [];
	let dynamicSlashCommandsKey = null;
	let dynamicSlashCommandsInFlightKey = null;
	let dynamicSlashCommandsRequestId = 0;
	let lastCtrlCAt = 0;
	let exitRequested = false;
	let exitResult = { exitReason: "exit" };
	let activityStatus = "idle";
	let connectionStatus = isLocalMode ? "starting local runtime" : "connecting";
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
		get pendingOptimisticUserMessage() {
			return pendingOptimisticUserMessage;
		},
		set pendingOptimisticUserMessage(value) {
			pendingOptimisticUserMessage = value;
		},
		get pendingChatRunId() {
			return pendingChatRunId;
		},
		set pendingChatRunId(value) {
			pendingChatRunId = value ?? null;
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
	const noteLocalBtwRunId = (runId) => {
		if (!runId) return;
		localBtwRunIds.add(runId);
		if (localBtwRunIds.size > 200) {
			const [first] = localBtwRunIds;
			if (first) localBtwRunIds.delete(first);
		}
	};
	const forgetLocalBtwRunId = (runId) => {
		localBtwRunIds.delete(runId);
	};
	const isLocalBtwRunId = (runId) => localBtwRunIds.has(runId);
	const clearLocalBtwRunIds = () => {
		localBtwRunIds.clear();
	};
	let client;
	if (opts.backend) client = opts.backend;
	else if (opts.local) {
		const { EmbeddedTuiBackend } = await import("./embedded-backend-V7gGSdAr.js");
		client = new EmbeddedTuiBackend();
	} else client = await GatewayChatClient.connect({
		url: opts.url,
		token: opts.token,
		password: opts.password
	});
	const previousConsoleSubsystemFilter = isLocalMode ? loggingState.consoleSubsystemFilter ? [...loggingState.consoleSubsystemFilter] : null : null;
	if (isLocalMode) setConsoleSubsystemFilter(["__openclaw_tui_quiet__"]);
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
	const resolveDynamicSlashCommandsKey = () => currentAgentId;
	const applyAutocompleteProvider = () => {
		const dynamicKey = resolveDynamicSlashCommandsKey();
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(getSlashCommands({
			cfg: config,
			local: isLocalMode,
			provider: sessionInfo.modelProvider,
			model: sessionInfo.model,
			thinkingLevels: sessionInfo.thinkingLevels,
			dynamicCommands: dynamicSlashCommandsKey === dynamicKey ? dynamicSlashCommands : []
		}), process.cwd()));
	};
	const refreshDynamicSlashCommands = () => {
		const key = resolveDynamicSlashCommandsKey();
		if (!isConnected || !client.listCommands || dynamicSlashCommandsKey === key || dynamicSlashCommandsInFlightKey === key) return;
		dynamicSlashCommandsInFlightKey = key;
		const requestId = ++dynamicSlashCommandsRequestId;
		const agentId = currentAgentId;
		client.listCommands({
			agentId,
			scope: "text",
			includeArgs: false
		}).then((commands) => {
			if (requestId !== dynamicSlashCommandsRequestId || key !== resolveDynamicSlashCommandsKey()) return;
			dynamicSlashCommands = commands;
			dynamicSlashCommandsKey = key;
			applyAutocompleteProvider();
		}).catch(() => void 0).finally(() => {
			if (dynamicSlashCommandsInFlightKey === key) dynamicSlashCommandsInFlightKey = null;
		});
	};
	const updateAutocompleteProvider = () => {
		applyAutocompleteProvider();
		refreshDynamicSlashCommands();
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
	const buildLastSessionScopeKeyFor = (sessionKey = currentSessionKey) => {
		const parsed = parseAgentSessionKey(sessionKey);
		return buildTuiLastSessionScopeKey({
			connectionUrl: client.connection.url,
			agentId: parsed?.agentId ?? currentAgentId,
			sessionScope
		});
	};
	const rememberCurrentSessionKey = (sessionKey) => {
		const trimmed = sessionKey.trim();
		if (!trimmed || trimmed === "unknown") return;
		writeTuiLastSessionKey({
			scopeKey: buildLastSessionScopeKeyFor(trimmed),
			sessionKey: trimmed
		}).catch(() => void 0);
	};
	const restoreRememberedSession = async () => {
		if (initialSessionInput || rememberedSessionApplied) return;
		rememberedSessionApplied = true;
		const remembered = await readTuiLastSessionKey({ scopeKey: buildLastSessionScopeKeyFor() });
		const rememberedKey = remembered ? resolveSessionKey(remembered) : null;
		if (!rememberedKey || rememberedKey === currentSessionKey) return;
		const rememberedAgent = parseAgentSessionKey(rememberedKey)?.agentId;
		if (rememberedAgent && normalizeAgentId(rememberedAgent) !== currentAgentId) return;
		const sessions = await client.listSessions({
			limit: 5,
			search: rememberedKey,
			includeGlobal: false,
			includeUnknown: false,
			agentId: currentAgentId
		}).catch(() => null);
		if (!sessions) return;
		const restored = resolveRememberedTuiSessionKey({
			rememberedKey,
			currentAgentId,
			sessions: sessions.sessions
		});
		if (!restored || restored === currentSessionKey) return;
		currentSessionKey = restored;
		updateHeader();
		updateFooter();
	};
	const updateHeader = () => {
		const sessionLabel = formatSessionKey(currentSessionKey);
		const agentLabel = formatAgentLabel(currentAgentId);
		const title = opts.title ?? "openclaw tui";
		header.setText(theme.header(`${title} - ${client.connection.url} - agent ${agentLabel} - session ${sessionLabel}`));
	};
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
			if (!isTuiBusyActivityStatus(activityStatus)) return;
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
		if (isTuiBusyActivityStatus(activityStatus)) {
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
			connectionStatus = isConnected ? isLocalMode ? "local ready" : "connected" : isLocalMode ? "local stopped" : "disconnected";
			renderStatus();
		}, ttlMs);
	};
	const setActivityStatus = (text) => {
		activityStatus = text;
		renderStatus();
	};
	const withTuiSuspended = async (work) => {
		await drainAndStopTuiSafely(tui);
		if (isLocalMode) setConsoleSubsystemFilter(previousConsoleSubsystemFilter);
		try {
			return await work();
		} finally {
			if (isLocalMode) setConsoleSubsystemFilter(["__openclaw_tui_quiet__"]);
			tui.start();
			tui.setFocus(editor);
			updateHeader();
			updateFooter();
			tui.requestRender(true);
		}
	};
	const runAuthFlow = isLocalMode ? async (params) => await withTuiSuspended(async () => await new Promise((resolve, reject) => {
		const provider = params.provider?.trim() || void 0;
		const codexBin = provider === OPENAI_CODEX_PROVIDER || !provider && sessionInfo.modelProvider === OPENAI_CODEX_PROVIDER ? resolveCodexCliBin() : null;
		let command;
		let args;
		if (codexBin) {
			command = codexBin;
			args = ["login"];
		} else {
			({command, args} = resolveLocalAuthCliInvocation());
			if (provider) args.push("--provider", provider);
		}
		const child = spawn(command, args, {
			cwd: resolveLocalAuthSpawnCwd({
				args,
				defaultCwd: process.cwd()
			}),
			env: process.env,
			stdio: "inherit",
			...resolveLocalAuthSpawnOptions({ command })
		});
		child.once("error", reject);
		child.once("exit", (exitCode, signal) => {
			resolve({
				exitCode,
				signal
			});
		});
	})) : void 0;
	const updateFooter = () => {
		const sessionKeyLabel = formatSessionKey(currentSessionKey);
		const sessionLabel = sessionInfo.displayName ? `${sessionKeyLabel} (${sessionInfo.displayName})` : sessionKeyLabel;
		const agentLabel = formatAgentLabel(currentAgentId);
		const modelLabel = sessionInfo.model ? sessionInfo.modelProvider ? `${sessionInfo.modelProvider}/${sessionInfo.model}` : sessionInfo.model : "unknown";
		const tokens = formatTokens(sessionInfo.totalTokens ?? null, sessionInfo.contextTokens ?? null);
		const think = sessionInfo.thinkingLevel ?? "off";
		const fast = sessionInfo.fastMode === true;
		const verbose = sessionInfo.verboseLevel ?? "off";
		const reasoning = sessionInfo.reasoningLevel ?? "off";
		const reasoningLabel = reasoning === "on" ? "reasoning" : reasoning === "stream" ? "reasoning:stream" : null;
		const footerParts = [
			`agent ${agentLabel}`,
			`session ${sessionLabel}`,
			modelLabel,
			think !== "off" ? `think ${think}` : null,
			fast ? "fast" : null,
			verbose !== "off" ? `verbose ${verbose}` : null,
			reasoningLabel,
			tokens
		].filter(Boolean);
		footer.setText(theme.dim(footerParts.join(" | ")));
	};
	const { openOverlay, closeOverlay } = createOverlayHandlers(tui, editor);
	const btw = {
		showResult: (params) => {
			chatLog.showBtw(params);
		},
		clear: () => {
			chatLog.dismissBtw();
		}
	};
	const initialSessionAgentId = (() => {
		if (!initialSessionInput) return null;
		const parsed = parseAgentSessionKey(initialSessionInput);
		return parsed ? normalizeAgentId(parsed.agentId) : null;
	})();
	const { refreshAgents, refreshSessionInfo, applySessionInfoFromPatch, loadHistory, setSession, abortActive } = createSessionActions({
		client,
		chatLog,
		btw,
		tui,
		opts,
		state,
		agentNames,
		initialSessionInput,
		initialSessionAgentId,
		resolveSessionKey,
		updateHeader,
		updateFooter,
		updateAutocompleteProvider,
		setActivityStatus,
		clearLocalRunIds,
		rememberSessionKey: rememberCurrentSessionKey
	});
	const { handleChatEvent, handleAgentEvent, handleBtwEvent, pauseStreamingWatchdog, reconnectStreamingWatchdog } = createEventHandlers({
		chatLog,
		btw,
		tui,
		state,
		localMode: isLocalMode,
		setActivityStatus,
		refreshSessionInfo,
		loadHistory,
		noteLocalRunId,
		isLocalRunId,
		forgetLocalRunId,
		clearLocalRunIds,
		isLocalBtwRunId,
		forgetLocalBtwRunId,
		clearLocalBtwRunIds
	});
	const deferredFinish = createDeferredTuiFinish();
	const forceExit = () => {
		try {
			process.stderr.write("openclaw tui forcing exit\n");
		} catch {}
		process.exit(130);
	};
	const requestExit = (result) => {
		if (exitRequested) {
			forceExit();
			return;
		}
		exitRequested = true;
		exitResult = {
			exitReason: result?.exitReason ?? "exit",
			...result?.crestodianMessage ? { crestodianMessage: result.crestodianMessage } : {}
		};
		const hardExitTimer = setTimeout(forceExit, resolveTuiShutdownHardExitMs({ localMode: isLocalMode }));
		hardExitTimer.unref?.();
		Promise.resolve().then(() => client.stop()).then(() => drainAndStopTuiSafely(tui)).finally(() => {
			clearTimeout(hardExitTimer);
		}).catch((err) => {
			if (!isTuiTerminalLossError(err)) try {
				process.stderr.write(`openclaw tui shutdown failed: ${String(err)}\n`);
			} catch {}
		}).finally(() => {
			deferredFinish.requestFinish();
		});
	};
	client.setRequestExitHandler?.(() => requestExit());
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
		noteLocalBtwRunId,
		forgetLocalRunId,
		forgetLocalBtwRunId,
		runAuthFlow,
		requestExit
	});
	const { runLocalShellLine } = createLocalShellRunner({
		chatLog,
		tui,
		openOverlay,
		closeOverlay
	});
	updateAutocompleteProvider();
	const canSubmitChatMessage = () => canSubmitTuiChatMessage({
		local: opts.local,
		activityStatus: state.activityStatus,
		activeChatRunId: state.activeChatRunId,
		pendingChatRunId: state.pendingChatRunId,
		pendingOptimisticUserMessage: state.pendingOptimisticUserMessage
	});
	const notifyBlockedChatSubmit = () => {
		chatLog.addSystem("agent is busy — press Esc to abort before sending a new message");
		tui.requestRender();
	};
	editor.onSubmit = createSubmitBurstCoalescer({
		submit: createEditorSubmitHandler({
			editor,
			handleCommand,
			sendMessage,
			handleBangLine: runLocalShellLine,
			canSubmitMessage: canSubmitChatMessage,
			onBlockedMessageSubmit: notifyBlockedChatSubmit
		}),
		enabled: shouldEnableWindowsGitBashPasteFallback()
	});
	editor.onEscape = () => {
		if (chatLog.hasVisibleBtw()) {
			chatLog.dismissBtw();
			tui.requestRender();
			return;
		}
		abortActive();
	};
	const handleCtrlC = () => {
		const now = Date.now();
		const decision = resolveTuiCtrlCAction({
			hasInput: editor.getText().trim().length > 0,
			now,
			lastCtrlCAt,
			exitRequested,
			wasDisconnected
		});
		if (decision.action === "force-exit") {
			forceExit();
			return;
		}
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
	tui.addInputListener((data) => {
		if (!chatLog.hasVisibleBtw()) return;
		if (editor.getText().length > 0) return;
		if (matchesKey(data, "enter")) {
			chatLog.dismissBtw();
			tui.requestRender();
			return { consume: true };
		}
	});
	client.onEvent = (evt) => {
		if (evt.event === "chat") handleChatEvent(evt.payload);
		if (evt.event === "chat.side_result") handleBtwEvent(evt.payload);
		if (evt.event === "agent") handleAgentEvent(evt.payload);
	};
	client.onConnected = () => {
		isConnected = true;
		pairingHintShown = false;
		const reconnected = wasDisconnected;
		wasDisconnected = false;
		if (reconnected) reconnectStreamingWatchdog();
		setConnectionStatus(isLocalMode ? "local ready" : "connected");
		(async () => {
			await refreshAgents();
			await restoreRememberedSession();
			updateHeader();
			updateAutocompleteProvider();
			await loadHistory();
			setConnectionStatus(isLocalMode ? "local ready" : reconnected ? "gateway reconnected" : "gateway connected", 4e3);
			tui.requestRender();
			if (!autoMessageSent && autoMessage) {
				autoMessageSent = true;
				await sendMessage(autoMessage);
			}
			updateFooter();
			tui.requestRender();
		})().catch((err) => {
			chatLog.addSystem(`startup failed: ${String(err)}`);
			setConnectionStatus("startup failed", 5e3);
			tui.requestRender();
		});
	};
	client.onDisconnected = (reason) => {
		isConnected = false;
		wasDisconnected = true;
		historyLoaded = false;
		dynamicSlashCommands = [];
		dynamicSlashCommandsKey = null;
		dynamicSlashCommandsInFlightKey = null;
		dynamicSlashCommandsRequestId += 1;
		updateAutocompleteProvider();
		pauseStreamingWatchdog();
		const disconnectState = isLocalMode ? {
			connectionStatus: `local runtime stopped${reason ? `: ${reason}` : ""}`,
			activityStatus: "idle",
			pairingHint: void 0
		} : resolveGatewayDisconnectState(reason);
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
	setConnectionStatus(isLocalMode ? "starting local runtime" : "connecting");
	updateFooter();
	const sigintHandler = () => {
		handleCtrlC();
	};
	const sigtermHandler = () => {
		requestExit();
	};
	const sighupHandler = () => {
		requestExit();
	};
	process.on("SIGINT", sigintHandler);
	process.on("SIGTERM", sigtermHandler);
	process.on("SIGHUP", sighupHandler);
	let cleanupTerminalLossHandler = installTuiTerminalLossExitHandler(() => requestExit());
	tui.start();
	client.start();
	await new Promise((resolve) => {
		const finish = () => {
			if (isLocalMode) setConsoleSubsystemFilter(previousConsoleSubsystemFilter);
			cleanupTerminalLossHandler?.();
			cleanupTerminalLossHandler = null;
			process.removeListener("SIGINT", sigintHandler);
			process.removeListener("SIGTERM", sigtermHandler);
			process.removeListener("SIGHUP", sighupHandler);
			process.removeListener("exit", finish);
			deferredFinish.clearFinish();
			resolve();
		};
		process.once("exit", finish);
		deferredFinish.setFinish(finish);
	});
	if (opts.forceProcessExitOnReturn === true) scheduleProcessExitAfterTuiReturn();
	return exitResult;
}
//#endregion
export { createSubmitBurstCoalescer as C, createEditorSubmitHandler as S, resolveFinalAssistantText as T, resolveTuiSessionKey as _, installTuiTerminalLossExitHandler as a, scheduleProcessExitAfterTuiReturn as b, isTuiTerminalLossError as c, resolveGatewayDisconnectState as d, resolveInitialTuiAgentId as f, resolveTuiCtrlCAction as g, resolveLocalAuthSpawnOptions as h, drainAndStopTuiSafely as i, resolveCodexCliBin as l, resolveLocalAuthSpawnCwd as m, createBackspaceDeduper as n, isIgnorableTuiStopError as o, resolveLocalAuthCliInvocation as p, createDeferredTuiFinish as r, isTuiBusyActivityStatus as s, canSubmitTuiChatMessage as t, resolveCtrlCAction as u, resolveTuiShutdownHardExitMs as v, shouldEnableWindowsGitBashPasteFallback as w, stopTuiSafely as x, runTui as y };
