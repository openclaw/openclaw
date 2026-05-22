import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { c as kindFromMime } from "./mime-B30DelN1.js";
import { t as resolveOutboundAttachmentFromUrl } from "./outbound-attachment-Ds7ht6T1.js";
import "./text-runtime-icMZVCaq.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DOmSgsqv.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-27YfIt4P.js";
import "./media-runtime-5rxXL-Os.js";
import "./markdown-table-runtime-BCQyeDEk.js";
import { i as resolveSignalAccount } from "./accounts-BOLNSiam.js";
import { t as markdownToSignalText } from "./format-DXbeXzRG.js";
import { n as signalRpcRequest } from "./client-BzRXH-Np.js";
import { t as resolveSignalRpcContext } from "./rpc-context-DAjUMtxL.js";
//#region extensions/signal/src/send.ts
async function resolveSignalRpcAccountInfo(opts) {
	if (opts.baseUrl?.trim() && opts.account?.trim()) return;
	if (!opts.cfg) throw new Error("Signal RPC account resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	return resolveSignalAccount({
		cfg: requireRuntimeConfig(opts.cfg, "Signal RPC account resolution"),
		accountId: opts.accountId
	});
}
function parseTarget(raw) {
	let value = raw.trim();
	if (!value) throw new Error("Signal recipient is required");
	if (normalizeLowercaseStringOrEmpty(value).startsWith("signal:")) value = value.slice(7).trim();
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if (normalized.startsWith("group:")) return {
		type: "group",
		groupId: value.slice(6).trim()
	};
	if (normalized.startsWith("username:")) return {
		type: "username",
		username: value.slice(9).trim()
	};
	if (normalized.startsWith("u:")) return {
		type: "username",
		username: value.trim()
	};
	return {
		type: "recipient",
		recipient: value
	};
}
function buildTargetParams(target, allow) {
	if (target.type === "recipient") {
		if (!allow.recipient) return null;
		return { recipient: [target.recipient] };
	}
	if (target.type === "group") {
		if (!allow.group) return null;
		return { groupId: target.groupId };
	}
	if (target.type === "username") {
		if (!allow.username) return null;
		return { username: [target.username] };
	}
	return null;
}
async function sendMessageSignal(to, text, opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "Signal send");
	const accountInfo = resolveSignalAccount({
		cfg,
		accountId: opts.accountId
	});
	const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
	const target = parseTarget(to);
	let message = text ?? "";
	let messageFromPlaceholder = false;
	let textStyles = [];
	const textMode = opts.textMode ?? "markdown";
	const maxBytes = (() => {
		if (typeof opts.maxBytes === "number") return opts.maxBytes;
		if (typeof accountInfo.config.mediaMaxMb === "number") return accountInfo.config.mediaMaxMb * 1024 * 1024;
		if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
		return 8 * 1024 * 1024;
	})();
	let attachments;
	if (opts.mediaUrl?.trim()) {
		const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
			mediaAccess: opts.mediaAccess,
			localRoots: opts.mediaLocalRoots,
			readFile: opts.mediaReadFile
		});
		attachments = [resolved.path];
		const kind = kindFromMime(resolved.contentType ?? void 0);
		if (!message && kind) {
			message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
			messageFromPlaceholder = true;
		}
	}
	if (message.trim() && !messageFromPlaceholder) if (textMode === "plain") textStyles = opts.textStyles ?? [];
	else {
		const tableMode = resolveMarkdownTableMode({
			cfg,
			channel: "signal",
			accountId: accountInfo.accountId
		});
		const formatted = markdownToSignalText(message, { tableMode });
		message = formatted.text;
		textStyles = formatted.styles;
	}
	if (!message.trim() && (!attachments || attachments.length === 0)) throw new Error("Signal send requires text or media");
	const params = { message };
	if (textStyles.length > 0) params["text-style"] = textStyles.map((style) => `${style.start}:${style.length}:${style.style}`);
	if (account) params.account = account;
	if (attachments && attachments.length > 0) params.attachments = attachments;
	const targetParams = buildTargetParams(target, {
		recipient: true,
		group: true,
		username: true
	});
	if (!targetParams) throw new Error("Signal recipient is required");
	Object.assign(params, targetParams);
	const timestamp = (await signalRpcRequest("send", params, {
		baseUrl,
		timeoutMs: opts.timeoutMs
	}))?.timestamp;
	return {
		messageId: timestamp ? String(timestamp) : "unknown",
		timestamp
	};
}
async function sendTypingSignal(to, opts) {
	const { baseUrl, account } = resolveSignalRpcContext(opts, await resolveSignalRpcAccountInfo(opts));
	const targetParams = buildTargetParams(parseTarget(to), {
		recipient: true,
		group: true
	});
	if (!targetParams) return false;
	const params = { ...targetParams };
	if (account) params.account = account;
	if (opts.stop) params.stop = true;
	await signalRpcRequest("sendTyping", params, {
		baseUrl,
		timeoutMs: opts.timeoutMs
	});
	return true;
}
async function sendReadReceiptSignal(to, targetTimestamp, opts) {
	if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) return false;
	const { baseUrl, account } = resolveSignalRpcContext(opts, await resolveSignalRpcAccountInfo(opts));
	const targetParams = buildTargetParams(parseTarget(to), { recipient: true });
	if (!targetParams) return false;
	const params = {
		...targetParams,
		targetTimestamp,
		type: opts.type ?? "read"
	};
	if (account) params.account = account;
	await signalRpcRequest("sendReceipt", params, {
		baseUrl,
		timeoutMs: opts.timeoutMs
	});
	return true;
}
//#endregion
export { sendReadReceiptSignal as n, sendTypingSignal as r, sendMessageSignal as t };
