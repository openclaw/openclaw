import { B as resolveRequiredHomeDir, P as resolveOAuthDir, R as resolveEffectiveHomeDir, S as getLogger, _ as warn, a as defaultRuntime, f as logVerbose, h as shouldLogVerbose, l as danger, p as logVerboseConsole, t as createSubsystemLogger, u as info, z as resolveHomeRelativePath } from "./subsystem-BrPedHYO.js";
import os from "node:os";
import path from "node:path";
import syncFs from "node:fs";
//#region src/infra/plain-object.ts
/**
* Strict plain-object guard (excludes arrays and host objects).
*/
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}
//#endregion
//#region src/utils.ts
async function ensureDir(dir) {
	await syncFs.promises.mkdir(dir, { recursive: true });
}
/**
* Check if a file or directory exists at the given path.
*/
async function pathExists(targetPath) {
	try {
		await syncFs.promises.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
function clampNumber(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
function clampInt(value, min, max) {
	return clampNumber(Math.floor(value), min, max);
}
/** Alias for clampNumber (shorter, more common name) */
const clamp = clampNumber;
/**
* Escapes special regex characters in a string so it can be used in a RegExp constructor.
*/
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Safely parse JSON, returning null on error instead of throwing.
*/
function safeParseJson(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
/**
* Type guard for Record<string, unknown> (less strict than isPlainObject).
* Accepts any non-null object that isn't an array.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeE164(number) {
	const digits = number.replace(/^whatsapp:/, "").trim().replace(/[^\d+]/g, "");
	if (digits.startsWith("+")) {return `+${digits.slice(1)}`;}
	return `+${digits}`;
}
/**
* "Self-chat mode" heuristic (single phone): the gateway is logged in as the owner's own WhatsApp account,
* and `channels.whatsapp.allowFrom` includes that same number. Used to avoid side-effects that make no sense when the
* "bot" and the human are the same WhatsApp identity (e.g. auto read receipts, @mention JID triggers).
*/
function isSelfChatMode(selfE164, allowFrom) {
	if (!selfE164) {return false;}
	if (!Array.isArray(allowFrom) || allowFrom.length === 0) {return false;}
	const normalizedSelf = normalizeE164(selfE164);
	return allowFrom.some((n) => {
		if (n === "*") {return false;}
		try {
			return normalizeE164(String(n)) === normalizedSelf;
		} catch {
			return false;
		}
	});
}
function toWhatsappJid(number) {
	const withoutPrefix = number.replace(/^whatsapp:/, "").trim();
	if (withoutPrefix.includes("@")) {return withoutPrefix;}
	return `${normalizeE164(withoutPrefix).replace(/\D/g, "")}@s.whatsapp.net`;
}
function resolveLidMappingDirs(opts) {
	const dirs = /* @__PURE__ */ new Set();
	const addDir = (dir) => {
		if (!dir) {return;}
		dirs.add(resolveUserPath(dir));
	};
	addDir(opts?.authDir);
	for (const dir of opts?.lidMappingDirs ?? []) {addDir(dir);}
	addDir(resolveOAuthDir());
	addDir(path.join(CONFIG_DIR, "credentials"));
	return [...dirs];
}
function readLidReverseMapping(lid, opts) {
	const mappingFilename = `lid-mapping-${lid}_reverse.json`;
	const mappingDirs = resolveLidMappingDirs(opts);
	for (const dir of mappingDirs) {
		const mappingPath = path.join(dir, mappingFilename);
		try {
			const data = syncFs.readFileSync(mappingPath, "utf8");
			const phone = JSON.parse(data);
			if (phone === null || phone === void 0) {continue;}
			return normalizeE164(String(phone));
		} catch {}
	}
	return null;
}
function jidToE164(jid, opts) {
	const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
	if (match) {return `+${match[1]}`;}
	const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
	if (lidMatch) {
		const lid = lidMatch[1];
		const phone = readLidReverseMapping(lid, opts);
		if (phone) {return phone;}
		if (opts?.logMissing ?? shouldLogVerbose()) {logVerbose(`LID mapping not found for ${lid}; skipping inbound message`);}
	}
	return null;
}
async function resolveJidToE164(jid, opts) {
	if (!jid) {return null;}
	const direct = jidToE164(jid, opts);
	if (direct) {return direct;}
	if (!/(@lid|@hosted\.lid)$/.test(jid)) {return null;}
	if (!opts?.lidLookup?.getPNForLID) {return null;}
	try {
		const pnJid = await opts.lidLookup.getPNForLID(jid);
		if (!pnJid) {return null;}
		return jidToE164(pnJid, opts);
	} catch (err) {
		if (shouldLogVerbose()) {logVerbose(`LID mapping lookup failed for ${jid}: ${String(err)}`);}
		return null;
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function isHighSurrogate(codeUnit) {
	return codeUnit >= 55296 && codeUnit <= 56319;
}
function isLowSurrogate(codeUnit) {
	return codeUnit >= 56320 && codeUnit <= 57343;
}
function sliceUtf16Safe(input, start, end) {
	const len = input.length;
	let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
	let to = end === void 0 ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
	if (to < from) {
		const tmp = from;
		from = to;
		to = tmp;
	}
	if (from > 0 && from < len) {
		if (isLowSurrogate(input.charCodeAt(from)) && isHighSurrogate(input.charCodeAt(from - 1))) {from += 1;}
	}
	if (to > 0 && to < len) {
		if (isHighSurrogate(input.charCodeAt(to - 1)) && isLowSurrogate(input.charCodeAt(to))) {to -= 1;}
	}
	return input.slice(from, to);
}
function truncateUtf16Safe(input, maxLen) {
	const limit = Math.max(0, Math.floor(maxLen));
	if (input.length <= limit) {return input;}
	return sliceUtf16Safe(input, 0, limit);
}
function resolveUserPath(input, env = process.env, homedir = os.homedir) {
	if (!input) {return "";}
	return resolveHomeRelativePath(input, {
		env,
		homedir
	});
}
function resolveConfigDir(env = process.env, homedir = os.homedir) {
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) {return resolveUserPath(override, env, homedir);}
	const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
	try {
		if (syncFs.existsSync(newDir)) {return newDir;}
	} catch {}
	return newDir;
}
function resolveHomeDir() {
	return resolveEffectiveHomeDir(process.env, os.homedir);
}
function resolveHomeDisplayPrefix() {
	const home = resolveHomeDir();
	if (!home) {return;}
	if (process.env.OPENCLAW_HOME?.trim()) {return {
		home,
		prefix: "$OPENCLAW_HOME"
	};}
	return {
		home,
		prefix: "~"
	};
}
function shortenHomePath(input) {
	if (!input) {return input;}
	const display = resolveHomeDisplayPrefix();
	if (!display) {return input;}
	const { home, prefix } = display;
	if (input === home) {return prefix;}
	if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {return `${prefix}${input.slice(home.length)}`;}
	return input;
}
function shortenHomeInString(input) {
	if (!input) {return input;}
	const display = resolveHomeDisplayPrefix();
	if (!display) {return input;}
	return input.split(display.home).join(display.prefix);
}
function formatTerminalLink(label, url, opts) {
	const esc = "\x1B";
	const safeLabel = label.replaceAll(esc, "");
	const safeUrl = url.replaceAll(esc, "");
	if (!(opts?.force === true ? true : opts?.force === false ? false : Boolean(process.stdout.isTTY))) {return opts?.fallback ?? `${safeLabel} (${safeUrl})`;}
	return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
const CONFIG_DIR = resolveConfigDir();
//#endregion
//#region src/logger.ts
const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;
function splitSubsystem(message) {
	const match = message.match(subsystemPrefixRe);
	if (!match) {return null;}
	const [, subsystem, rest] = match;
	return {
		subsystem,
		rest
	};
}
function logWithSubsystem(params) {
	const parsed = params.runtime === defaultRuntime ? splitSubsystem(params.message) : null;
	if (parsed) {
		createSubsystemLogger(parsed.subsystem)[params.subsystemMethod](parsed.rest);
		return;
	}
	params.runtime[params.runtimeMethod](params.runtimeFormatter(params.message));
	getLogger()[params.loggerMethod](params.message);
}
function logInfo(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "log",
		runtimeFormatter: info,
		loggerMethod: "info",
		subsystemMethod: "info"
	});
}
function logWarn(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "log",
		runtimeFormatter: warn,
		loggerMethod: "warn",
		subsystemMethod: "warn"
	});
}
function logError(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "error",
		runtimeFormatter: danger,
		loggerMethod: "error",
		subsystemMethod: "error"
	});
}
function logDebug(message) {
	getLogger().debug(message);
	logVerboseConsole(message);
}
//#endregion
export { sleep as C, isPlainObject as D, truncateUtf16Safe as E, shortenHomePath as S, toWhatsappJid as T, resolveConfigDir as _, CONFIG_DIR as a, safeParseJson as b, clampNumber as c, formatTerminalLink as d, isRecord as f, pathExists as g, normalizeE164 as h, logWarn as i, ensureDir as l, jidToE164 as m, logError as n, clamp as o, isSelfChatMode as p, logInfo as r, clampInt as s, logDebug as t, escapeRegExp as u, resolveJidToE164 as v, sliceUtf16Safe as w, shortenHomeInString as x, resolveUserPath as y };
