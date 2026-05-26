import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { u as withTimeout } from "./fs-safe-CV86zY9G.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { a as tryReadSecretFileSync } from "./secret-file-DsUhZ-Ug.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import { r as parseOptionalDelimitedEntries } from "./helpers-CswdXPdi.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import "./channel-core-CV-k5W6W.js";
import "./secret-input-CWnTb0tw.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import "./text-chunking-C154U6-i.js";
import "./security-runtime-CcSekjBd.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import "./account-resolution-Dy8RKAMt.js";
import "./channel-message-DMGbyII_.js";
import { t as getIrcRuntime } from "./runtime-D93ZFhUB.js";
import net from "node:net";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
//#region extensions/irc/src/accounts.ts
const TRUTHY_ENV = new Set([
	"true",
	"1",
	"yes",
	"on"
]);
function parseTruthy(value) {
	if (!value) return false;
	return TRUTHY_ENV.has(normalizeLowercaseStringOrEmpty(value));
}
function parseIntEnv(value) {
	if (!value?.trim()) return;
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return;
	return parsed;
}
const { listAccountIds: listIrcAccountIds, resolveDefaultAccountId: resolveDefaultIrcAccountId } = createAccountListHelpers("irc", {
	normalizeAccountId,
	hasImplicitDefaultAccount: (cfg) => Boolean((cfg.channels?.irc?.host?.trim() || process.env.IRC_HOST?.trim()) && (cfg.channels?.irc?.nick?.trim() || process.env.IRC_NICK?.trim()))
});
function mergeIrcAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.irc,
		accounts: cfg.channels?.irc?.accounts,
		accountId,
		omitKeys: ["defaultAccount"],
		normalizeAccountId,
		nestedObjectKeys: ["nickserv"]
	});
}
function resolvePassword(accountId, merged) {
	if (accountId === "default") {
		const envPassword = process.env.IRC_PASSWORD?.trim();
		if (envPassword) return {
			password: envPassword,
			source: "env"
		};
	}
	if (merged.passwordFile?.trim()) {
		const filePassword = tryReadSecretFileSync(merged.passwordFile, "IRC password file", { rejectSymlink: true });
		if (filePassword) return {
			password: filePassword,
			source: "passwordFile"
		};
	}
	const configPassword = normalizeResolvedSecretInputString({
		value: merged.password,
		path: `channels.irc.accounts.${accountId}.password`
	});
	if (configPassword) return {
		password: configPassword,
		source: "config"
	};
	return {
		password: "",
		source: "none"
	};
}
function resolveNickServConfig(accountId, nickserv) {
	const base = nickserv ?? {};
	const envPassword = accountId === "default" ? process.env.IRC_NICKSERV_PASSWORD?.trim() : void 0;
	const envRegisterEmail = accountId === "default" ? process.env.IRC_NICKSERV_REGISTER_EMAIL?.trim() : void 0;
	const passwordFile = base.passwordFile?.trim();
	let resolvedPassword = normalizeResolvedSecretInputString({
		value: base.password,
		path: `channels.irc.accounts.${accountId}.nickserv.password`
	}) || envPassword || "";
	if (!resolvedPassword && passwordFile) resolvedPassword = tryReadSecretFileSync(passwordFile, "IRC NickServ password file", { rejectSymlink: true }) ?? "";
	return {
		...base,
		service: normalizeOptionalString(base.service),
		passwordFile: passwordFile || void 0,
		password: resolvedPassword || void 0,
		registerEmail: base.registerEmail?.trim() || envRegisterEmail || void 0
	};
}
function resolveIrcAccount(params) {
	const hasExplicitAccountId = Boolean(params.accountId?.trim());
	const baseEnabled = params.cfg.channels?.irc?.enabled !== false;
	const resolve = (accountId) => {
		const merged = mergeIrcAccountConfig(params.cfg, accountId);
		const accountEnabled = merged.enabled !== false;
		const enabled = baseEnabled && accountEnabled;
		const tls = typeof merged.tls === "boolean" ? merged.tls : accountId === "default" && process.env.IRC_TLS ? parseTruthy(process.env.IRC_TLS) : true;
		const envPort = accountId === "default" ? parseIntEnv(process.env.IRC_PORT) : void 0;
		const port = merged.port ?? envPort ?? (tls ? 6697 : 6667);
		const envChannels = accountId === "default" ? parseOptionalDelimitedEntries(process.env.IRC_CHANNELS) : void 0;
		const host = (merged.host?.trim() || (accountId === "default" ? process.env.IRC_HOST?.trim() : "") || "").trim();
		const nick = (merged.nick?.trim() || (accountId === "default" ? process.env.IRC_NICK?.trim() : "") || "").trim();
		const username = (merged.username?.trim() || (accountId === "default" ? process.env.IRC_USERNAME?.trim() : "") || nick || "openclaw").trim();
		const realname = (merged.realname?.trim() || (accountId === "default" ? process.env.IRC_REALNAME?.trim() : "") || "OpenClaw").trim();
		const passwordResolution = resolvePassword(accountId, merged);
		const nickserv = resolveNickServConfig(accountId, merged.nickserv);
		const config = {
			...merged,
			channels: merged.channels ?? envChannels,
			tls,
			port,
			host,
			nick,
			username,
			realname,
			nickserv
		};
		return {
			accountId,
			enabled,
			name: normalizeOptionalString(merged.name),
			configured: Boolean(host && nick),
			host,
			port,
			tls,
			nick,
			username,
			realname,
			password: passwordResolution.password,
			passwordSource: passwordResolution.source,
			config
		};
	};
	const primary = resolve(normalizeAccountId(params.accountId));
	if (hasExplicitAccountId) return primary;
	if (primary.configured) return primary;
	const fallbackId = resolveDefaultIrcAccountId(params.cfg);
	if (fallbackId === primary.accountId) return primary;
	const fallback = resolve(fallbackId);
	if (!fallback.configured) return primary;
	return fallback;
}
function listEnabledIrcAccounts(cfg) {
	return listIrcAccountIds(cfg).map((accountId) => resolveIrcAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
//#region extensions/irc/src/control-chars.ts
function isIrcControlChar(charCode) {
	return charCode <= 31 || charCode === 127;
}
function hasIrcControlChars(value) {
	for (const char of value) if (isIrcControlChar(char.charCodeAt(0))) return true;
	return false;
}
function stripIrcControlChars(value) {
	let out = "";
	for (const char of value) if (!isIrcControlChar(char.charCodeAt(0))) out += char;
	return out;
}
//#endregion
//#region extensions/irc/src/protocol.ts
const IRC_TARGET_PATTERN$1 = /^[^\s:]+$/u;
function parseIrcLine(line) {
	const raw = line.replace(/[\r\n]+/g, "").trim();
	if (!raw) return null;
	let cursor = raw;
	let prefix;
	if (cursor.startsWith(":")) {
		const idx = cursor.indexOf(" ");
		if (idx <= 1) return null;
		prefix = cursor.slice(1, idx);
		cursor = cursor.slice(idx + 1).trimStart();
	}
	if (!cursor) return null;
	const firstSpace = cursor.indexOf(" ");
	const command = (firstSpace === -1 ? cursor : cursor.slice(0, firstSpace)).trim();
	if (!command) return null;
	cursor = firstSpace === -1 ? "" : cursor.slice(firstSpace + 1);
	const params = [];
	let trailing;
	while (cursor.length > 0) {
		cursor = cursor.trimStart();
		if (!cursor) break;
		if (cursor.startsWith(":")) {
			trailing = cursor.slice(1);
			break;
		}
		const spaceIdx = cursor.indexOf(" ");
		if (spaceIdx === -1) {
			params.push(cursor);
			break;
		}
		params.push(cursor.slice(0, spaceIdx));
		cursor = cursor.slice(spaceIdx + 1);
	}
	return {
		raw,
		prefix,
		command: command.toUpperCase(),
		params,
		trailing
	};
}
function parseIrcPrefix(prefix) {
	if (!prefix) return {};
	const nickPart = prefix.match(/^([^!@]+)!([^@]+)@(.+)$/);
	if (nickPart) return {
		nick: nickPart[1],
		user: nickPart[2],
		host: nickPart[3]
	};
	const nickHostPart = prefix.match(/^([^@]+)@(.+)$/);
	if (nickHostPart) return {
		nick: nickHostPart[1],
		host: nickHostPart[2]
	};
	if (prefix.includes("!")) {
		const [nick, user] = prefix.split("!", 2);
		return {
			nick,
			user
		};
	}
	if (prefix.includes(".")) return { server: prefix };
	return { nick: prefix };
}
function decodeLiteralEscapes(input) {
	return input.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\0/g, "\0").replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
function sanitizeIrcOutboundText(text) {
	return stripIrcControlChars(decodeLiteralEscapes(text).replace(/\r?\n/g, " ")).trim();
}
function sanitizeIrcTarget(raw) {
	const decoded = decodeLiteralEscapes(raw);
	if (!decoded) throw new Error("IRC target is required");
	if (decoded !== decoded.trim()) throw new Error(`Invalid IRC target: ${raw}`);
	if (hasIrcControlChars(decoded)) throw new Error(`Invalid IRC target: ${raw}`);
	if (!IRC_TARGET_PATTERN$1.test(decoded)) throw new Error(`Invalid IRC target: ${raw}`);
	return decoded;
}
function makeIrcMessageId() {
	return randomUUID();
}
//#endregion
//#region extensions/irc/src/client.ts
const IRC_ERROR_CODES = new Set([
	"432",
	"464",
	"465"
]);
const IRC_NICK_COLLISION_CODES = new Set(["433", "436"]);
function toError(err) {
	if (err instanceof Error) return err;
	return new Error(typeof err === "string" ? err : JSON.stringify(err));
}
function buildFallbackNick(nick) {
	const base = nick.replace(/\s+/g, "").replace(/[^A-Za-z0-9_\-[\]\\`^{}|]/g, "") || "openclaw";
	const suffix = "_";
	const maxNickLen = 30;
	if (base.length >= maxNickLen) return `${base.slice(0, maxNickLen - 1)}${suffix}`;
	return `${base}${suffix}`;
}
function normalizeIrcNick(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function buildIrcNickServCommands(options) {
	if (!options || options.enabled === false) return [];
	const password = sanitizeIrcOutboundText(options.password ?? "");
	if (!password) return [];
	const service = sanitizeIrcTarget(options.service?.trim() || "NickServ");
	const commands = [`PRIVMSG ${service} :IDENTIFY ${password}`];
	if (options.register) {
		const registerEmail = sanitizeIrcOutboundText(options.registerEmail ?? "");
		if (!registerEmail) throw new Error("IRC NickServ register requires registerEmail");
		commands.push(`PRIVMSG ${service} :REGISTER ${password} ${registerEmail}`);
	}
	return commands;
}
async function connectIrcClient(options) {
	const timeoutMs = options.connectTimeoutMs != null ? options.connectTimeoutMs : 15e3;
	const messageChunkMaxChars = options.messageChunkMaxChars != null ? options.messageChunkMaxChars : 350;
	if (!options.host.trim()) throw new Error("IRC host is required");
	if (!options.nick.trim()) throw new Error("IRC nick is required");
	const desiredNick = options.nick.trim();
	let currentNick = desiredNick;
	let ready = false;
	let closed = false;
	let nickServRecoverAttempted = false;
	let fallbackNickAttempted = false;
	const socket = options.tls ? tls.connect({
		host: options.host,
		port: options.port,
		servername: options.host
	}) : net.connect({
		host: options.host,
		port: options.port
	});
	socket.setEncoding("utf8");
	let resolveReady = null;
	let rejectReady = null;
	const readyPromise = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const fail = (err) => {
		const error = toError(err);
		if (options.onError) options.onError(error);
		if (!ready && rejectReady) {
			rejectReady(error);
			rejectReady = null;
			resolveReady = null;
		}
	};
	const sendRaw = (line) => {
		const cleaned = line.replace(/[\r\n]+/g, "").trim();
		if (!cleaned) throw new Error("IRC command cannot be empty");
		socket.write(`${cleaned}\r\n`);
	};
	const tryRecoverNickCollision = () => {
		const nickServEnabled = options.nickserv?.enabled !== false;
		const nickservPassword = sanitizeIrcOutboundText(options.nickserv?.password ?? "");
		if (nickServEnabled && !nickServRecoverAttempted && nickservPassword) {
			nickServRecoverAttempted = true;
			try {
				sendRaw(`PRIVMSG ${sanitizeIrcTarget(options.nickserv?.service?.trim() || "NickServ")} :GHOST ${desiredNick} ${nickservPassword}`);
				sendRaw(`NICK ${desiredNick}`);
				return true;
			} catch (err) {
				fail(err);
			}
		}
		if (!fallbackNickAttempted) {
			fallbackNickAttempted = true;
			const fallbackNick = buildFallbackNick(desiredNick);
			if (normalizeIrcNick(fallbackNick) !== normalizeIrcNick(currentNick)) try {
				sendRaw(`NICK ${fallbackNick}`);
				currentNick = fallbackNick;
				return true;
			} catch (err) {
				fail(err);
			}
		}
		return false;
	};
	const join = (channel) => {
		const target = sanitizeIrcTarget(channel);
		if (!target.startsWith("#") && !target.startsWith("&")) throw new Error(`IRC JOIN target must be a channel: ${channel}`);
		sendRaw(`JOIN ${target}`);
	};
	const sendPrivmsg = (target, text) => {
		const normalizedTarget = sanitizeIrcTarget(target);
		const cleaned = sanitizeIrcOutboundText(text);
		if (!cleaned) return;
		let remaining = cleaned;
		while (remaining.length > 0) {
			let chunk = remaining;
			if (chunk.length > messageChunkMaxChars) {
				let splitAt = chunk.lastIndexOf(" ", messageChunkMaxChars);
				if (splitAt < Math.floor(messageChunkMaxChars / 2)) splitAt = messageChunkMaxChars;
				chunk = chunk.slice(0, splitAt).trim();
			}
			if (!chunk) break;
			sendRaw(`PRIVMSG ${normalizedTarget} :${chunk}`);
			remaining = remaining.slice(chunk.length).trimStart();
		}
	};
	const quit = (reason) => {
		if (closed) return;
		closed = true;
		const safeReason = sanitizeIrcOutboundText(reason != null ? reason : "bye");
		try {
			if (safeReason) sendRaw(`QUIT :${safeReason}`);
			else sendRaw("QUIT");
		} catch {}
		socket.end();
	};
	const close = () => {
		if (closed) return;
		closed = true;
		socket.destroy();
	};
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		let idx = buffer.indexOf("\n");
		while (idx !== -1) {
			const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
			idx = buffer.indexOf("\n");
			if (!rawLine) continue;
			if (options.onLine) options.onLine(rawLine);
			const line = parseIrcLine(rawLine);
			if (!line) continue;
			if (line.command === "PING") {
				sendRaw(`PONG :${line.trailing != null ? line.trailing : line.params[0] != null ? line.params[0] : ""}`);
				continue;
			}
			if (line.command === "NICK") {
				const prefix = parseIrcPrefix(line.prefix);
				if (prefix.nick && normalizeIrcNick(prefix.nick) === normalizeIrcNick(currentNick)) currentNick = (line.trailing != null ? line.trailing : line.params[0] != null ? line.params[0] : currentNick).trim();
				continue;
			}
			if (!ready && IRC_NICK_COLLISION_CODES.has(line.command)) {
				if (tryRecoverNickCollision()) continue;
				const detail = line.trailing != null ? line.trailing : line.params.join(" ") || "nickname in use";
				fail(/* @__PURE__ */ new Error(`IRC login failed (${line.command}): ${detail}`));
				close();
				return;
			}
			if (!ready && IRC_ERROR_CODES.has(line.command)) {
				const detail = line.trailing != null ? line.trailing : line.params.join(" ") || "login rejected";
				fail(/* @__PURE__ */ new Error(`IRC login failed (${line.command}): ${detail}`));
				close();
				return;
			}
			if (line.command === "001") {
				ready = true;
				const nickParam = line.params[0];
				if (nickParam && nickParam.trim()) currentNick = nickParam.trim();
				try {
					const nickServCommands = buildIrcNickServCommands(options.nickserv);
					for (const command of nickServCommands) sendRaw(command);
				} catch (err) {
					fail(err);
				}
				for (const channel of options.channels || []) {
					const trimmed = channel.trim();
					if (!trimmed) continue;
					try {
						join(trimmed);
					} catch (err) {
						fail(err);
					}
				}
				if (resolveReady) resolveReady();
				resolveReady = null;
				rejectReady = null;
				continue;
			}
			if (line.command === "NOTICE") {
				if (options.onNotice) options.onNotice(line.trailing != null ? line.trailing : "", line.params[0]);
				continue;
			}
			if (line.command === "PRIVMSG") {
				const targetParam = line.params[0];
				const target = targetParam ? targetParam.trim() : "";
				const text = line.trailing != null ? line.trailing : "";
				const prefix = parseIrcPrefix(line.prefix);
				const senderNick = prefix.nick ? prefix.nick.trim() : "";
				if (!target || !senderNick || !text.trim()) continue;
				if (options.onPrivmsg) Promise.resolve(options.onPrivmsg({
					senderNick,
					senderUser: prefix.user ? prefix.user.trim() : void 0,
					senderHost: prefix.host ? prefix.host.trim() : void 0,
					target,
					text,
					rawLine
				})).catch((error) => {
					fail(error);
				});
			}
		}
	});
	socket.once("connect", () => {
		try {
			if (options.password && options.password.trim()) sendRaw(`PASS ${options.password.trim()}`);
			sendRaw(`NICK ${options.nick.trim()}`);
			sendRaw(`USER ${options.username.trim()} 0 * :${sanitizeIrcOutboundText(options.realname)}`);
		} catch (err) {
			fail(err);
			close();
		}
	});
	socket.once("error", (err) => {
		fail(err);
	});
	socket.once("close", () => {
		if (!closed) {
			closed = true;
			if (!ready) fail(/* @__PURE__ */ new Error("IRC connection closed before ready"));
		}
	});
	if (options.abortSignal) {
		const abort = () => {
			quit("shutdown");
		};
		if (options.abortSignal.aborted) abort();
		else options.abortSignal.addEventListener("abort", abort, { once: true });
	}
	await withTimeout(readyPromise, timeoutMs, "IRC connect");
	return {
		get nick() {
			return currentNick;
		},
		isReady: () => ready && !closed,
		sendRaw,
		join,
		sendPrivmsg,
		quit,
		close
	};
}
//#endregion
//#region extensions/irc/src/connect-options.ts
function buildIrcConnectOptions(account, overrides = {}) {
	return {
		host: account.host,
		port: account.port,
		tls: account.tls,
		nick: account.nick,
		username: account.username,
		realname: account.realname,
		password: account.password,
		nickserv: {
			enabled: account.config.nickserv?.enabled,
			service: account.config.nickserv?.service,
			password: account.config.nickserv?.password,
			register: account.config.nickserv?.register,
			registerEmail: account.config.nickserv?.registerEmail
		},
		...overrides
	};
}
//#endregion
//#region extensions/irc/src/normalize.ts
const IRC_TARGET_PATTERN = /^[^\s:]+$/u;
function isChannelTarget(target) {
	return target.startsWith("#") || target.startsWith("&");
}
function normalizeIrcMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	let target = trimmed;
	if (normalizeLowercaseStringOrEmpty(target).startsWith("irc:")) target = target.slice(4).trim();
	if (normalizeLowercaseStringOrEmpty(target).startsWith("channel:")) {
		target = target.slice(8).trim();
		if (!target.startsWith("#") && !target.startsWith("&")) target = `#${target}`;
	}
	if (normalizeLowercaseStringOrEmpty(target).startsWith("user:")) target = target.slice(5).trim();
	if (!target || !looksLikeIrcTargetId(target)) return;
	return target;
}
function looksLikeIrcTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (hasIrcControlChars(trimmed)) return false;
	return IRC_TARGET_PATTERN.test(trimmed);
}
function normalizeIrcAllowEntry(raw) {
	let value = normalizeLowercaseStringOrEmpty(raw);
	if (!value) return "";
	if (value.startsWith("irc:")) value = value.slice(4);
	if (value.startsWith("user:")) value = value.slice(5);
	return value.trim();
}
function buildIrcAllowlistCandidates(message, params) {
	const nick = normalizeLowercaseStringOrEmpty(message.senderNick);
	const user = normalizeOptionalLowercaseString(message.senderUser);
	const host = normalizeOptionalLowercaseString(message.senderHost);
	const candidates = /* @__PURE__ */ new Set();
	if (nick && params?.allowNameMatching === true) candidates.add(nick);
	if (nick && user) candidates.add(`${nick}!${user}`);
	if (nick && host) candidates.add(`${nick}@${host}`);
	if (nick && user && host) candidates.add(`${nick}!${user}@${host}`);
	return [...candidates];
}
//#endregion
//#region extensions/irc/src/send.ts
function recordIrcOutboundActivity(accountId) {
	try {
		getIrcRuntime().channel.activity.record({
			channel: "irc",
			accountId,
			direction: "outbound"
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "IRC runtime not initialized") throw error;
	}
}
function resolveTarget(to, opts) {
	const fromArg = normalizeIrcMessagingTarget(to);
	if (fromArg) return fromArg;
	const fromOpt = normalizeIrcMessagingTarget(opts?.target ?? "");
	if (fromOpt) return fromOpt;
	throw new Error(`Invalid IRC target: ${to}`);
}
async function sendMessageIrc(to, text, opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "IRC send");
	const account = resolveIrcAccount({
		cfg,
		accountId: opts.accountId
	});
	if (!account.configured) throw new Error(`IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`);
	const target = resolveTarget(to, opts);
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "irc",
		accountId: account.accountId
	});
	const prepared = convertMarkdownTables(text.trim(), tableMode);
	const payload = opts.replyTo ? `${prepared}\n\n[reply:${opts.replyTo}]` : prepared;
	if (!payload.trim()) throw new Error("Message must be non-empty for IRC sends");
	const client = opts.client;
	if (client?.isReady()) client.sendPrivmsg(target, payload);
	else {
		const transient = await connectIrcClient(buildIrcConnectOptions(account, { connectTimeoutMs: 12e3 }));
		transient.sendPrivmsg(target, payload);
		transient.quit("sent");
	}
	recordIrcOutboundActivity(account.accountId);
	const messageId = makeIrcMessageId();
	return {
		messageId,
		target,
		receipt: createMessageReceiptFromOutboundResults({
			results: [{
				channel: "irc",
				messageId,
				conversationId: target
			}],
			kind: "text",
			...opts.replyTo ? { replyToId: opts.replyTo } : {}
		})
	};
}
//#endregion
//#region extensions/irc/src/policy.ts
function resolveIrcGroupMatch(params) {
	const groups = params.groups ?? {};
	const hasConfiguredGroups = Object.keys(groups).length > 0;
	const direct = groups[params.target];
	if (direct) return {
		allowed: true,
		groupConfig: direct,
		wildcardConfig: groups["*"],
		hasConfiguredGroups
	};
	const targetLower = normalizeLowercaseStringOrEmpty(params.target);
	const directKey = Object.keys(groups).find((key) => normalizeLowercaseStringOrEmpty(key) === targetLower);
	if (directKey) {
		const matched = groups[directKey];
		if (matched) return {
			allowed: true,
			groupConfig: matched,
			wildcardConfig: groups["*"],
			hasConfiguredGroups
		};
	}
	const wildcard = groups["*"];
	if (wildcard) return {
		allowed: true,
		wildcardConfig: wildcard,
		hasConfiguredGroups
	};
	return {
		allowed: false,
		hasConfiguredGroups
	};
}
function resolveIrcRequireMention(params) {
	if (params.groupConfig?.requireMention !== void 0) return params.groupConfig.requireMention;
	if (params.wildcardConfig?.requireMention !== void 0) return params.wildcardConfig.requireMention;
	return true;
}
//#endregion
export { isChannelTarget as a, normalizeIrcMessagingTarget as c, makeIrcMessageId as d, listEnabledIrcAccounts as f, resolveIrcAccount as h, buildIrcAllowlistCandidates as i, buildIrcConnectOptions as l, resolveDefaultIrcAccountId as m, resolveIrcRequireMention as n, looksLikeIrcTargetId as o, listIrcAccountIds as p, sendMessageIrc as r, normalizeIrcAllowEntry as s, resolveIrcGroupMatch as t, connectIrcClient as u };
