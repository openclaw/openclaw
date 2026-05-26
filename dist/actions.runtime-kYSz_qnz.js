import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import "./temp-path-DllZid8c.js";
import { t as createIMessageRpcClient } from "./client-BcN4Qxqo.js";
import { i as resolveIMessageMessageId } from "./monitor-reply-cache-VQxHiKhg.js";
import { t as extractMarkdownFormatRuns } from "./markdown-format-Cqti91oT.js";
import { extname, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
//#region extensions/imessage/src/actions.runtime.ts
function asChatList(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const chats = value.chats;
	if (!Array.isArray(chats)) return [];
	return chats.filter((chat) => chat != null && typeof chat === "object" && !Array.isArray(chat));
}
function numberFromUnknown(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
}
function stringFromUnknown(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
const CHAT_LIST_CACHE_TTL_MS = 30 * 1e3;
const chatListCache = /* @__PURE__ */ new Map();
function chatListCacheKey(cliPath, dbPath) {
	return `${cliPath}\0${dbPath ?? ""}`;
}
function chatListCacheGet(cliPath, dbPath) {
	const entry = chatListCache.get(chatListCacheKey(cliPath, dbPath));
	if (!entry) return null;
	if (entry.expiresAt < Date.now()) {
		chatListCache.delete(chatListCacheKey(cliPath, dbPath));
		return null;
	}
	return entry.list;
}
function chatListCacheSet(cliPath, dbPath, list) {
	chatListCache.set(chatListCacheKey(cliPath, dbPath), {
		list,
		expiresAt: Date.now() + CHAT_LIST_CACHE_TTL_MS
	});
}
/**
* Strip the iMessage;-;/SMS;-;/any;-; service prefix that Messages uses
* for direct DM chats. Different layers report direct DMs in different
* forms — the action surface synthesizes `iMessage;-;<phone>` from a
* handle target, while imsg's chats.list returns `identifier: <phone>`
* and `guid: any;-;<phone>`. Comparing the raw strings would falsely
* miss the match. Mirror of the same helper in monitor-reply-cache.ts.
*/
function normalizeDirectChatIdentifierForTest(raw) {
	return normalizeDirectChatIdentifier(raw);
}
function findChatGuidForTest(chats, target) {
	return findChatGuid(chats, target);
}
function normalizeDirectChatIdentifier(raw) {
	const trimmed = raw.trim();
	const lowered = trimmed.toLowerCase();
	for (const prefix of [
		"imessage;-;",
		"sms;-;",
		"any;-;"
	]) if (lowered.startsWith(prefix)) return trimmed.slice(prefix.length);
	return trimmed;
}
function findChatGuid(chats, target) {
	if (target.kind === "chat_id") {
		for (const chat of chats) {
			const id = numberFromUnknown(chat.id);
			const guid = stringFromUnknown(chat.guid);
			if (id === target.chatId && guid) return guid;
		}
		return null;
	}
	const wanted = normalizeDirectChatIdentifier(target.chatIdentifier);
	for (const chat of chats) {
		const identifier = stringFromUnknown(chat.identifier);
		const guid = stringFromUnknown(chat.guid);
		if (!guid) continue;
		if (identifier === target.chatIdentifier || guid === target.chatIdentifier || identifier && normalizeDirectChatIdentifier(identifier) === wanted || normalizeDirectChatIdentifier(guid) === wanted) return guid;
	}
	return null;
}
function buildIMessageCliJsonArgs(args, options) {
	const dbPath = options.dbPath?.trim();
	return [
		...args,
		...dbPath ? ["--db", dbPath] : [],
		"--json"
	];
}
async function runIMessageCliJson(args, options) {
	return await new Promise((resolve, reject) => {
		const child = spawn(options.cliPath, buildIMessageCliJsonArgs(args, options), { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		let killEscalation = null;
		const timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => {
			child.kill("SIGTERM");
			killEscalation = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, 2e3);
			reject(/* @__PURE__ */ new Error(`iMessage action timed out after ${options.timeoutMs}ms`));
		}, options.timeoutMs) : null;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			if (killEscalation) clearTimeout(killEscalation);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (killEscalation) clearTimeout(killEscalation);
			const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
			let parsed = null;
			if (last) try {
				const value = JSON.parse(last);
				if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
			} catch {
				parsed = null;
			}
			if (code !== 0) {
				const detail = typeof parsed?.error === "string" && parsed.error.trim() || stderr.trim() || stdout.trim() || `imsg exited with code ${code}`;
				reject(new Error(detail));
				return;
			}
			if (!parsed) {
				reject(/* @__PURE__ */ new Error(`imsg returned non-JSON output: ${stdout.trim() || stderr.trim()}`));
				return;
			}
			if (parsed.success === false) {
				const error = typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : "iMessage action failed";
				reject(new Error(error));
				return;
			}
			resolve(parsed);
		});
	});
}
function resolveMessageId(result) {
	return typeof result.messageGuid === "string" && result.messageGuid.trim() || typeof result.messageId === "string" && result.messageId.trim() || typeof result.guid === "string" && result.guid.trim() || typeof result.id === "string" && result.id.trim() || "ok";
}
async function withTempFile(input, fn) {
	const dir = await mkdtemp(join(resolvePreferredOpenClawTmpDir(), "openclaw-imessage-"));
	const filePath = join(dir, `upload${extname(input.filename).slice(0, 16) || ".bin"}`);
	try {
		await writeFile(filePath, input.buffer);
		return await fn(filePath);
	} finally {
		await rm(dir, {
			recursive: true,
			force: true
		});
	}
}
const imessageActionsRuntime = {
	resolveIMessageMessageId,
	async resolveChatGuidForTarget(params) {
		const cached = chatListCacheGet(params.options.cliPath, params.options.dbPath);
		if (cached) return findChatGuid(cached, params.target);
		const client = await createIMessageRpcClient({
			cliPath: params.options.cliPath,
			dbPath: params.options.dbPath
		});
		try {
			const list = asChatList(await client.request("chats.list", { limit: 1e3 }, { timeoutMs: params.options.timeoutMs }));
			chatListCacheSet(params.options.cliPath, params.options.dbPath, list);
			return findChatGuid(list, params.target);
		} finally {
			await client.stop();
		}
	},
	async sendReaction(params) {
		await runIMessageCliJson([
			"tapback",
			"--chat",
			params.chatGuid,
			"--message",
			params.messageId,
			"--kind",
			params.reaction,
			"--part",
			String(params.partIndex ?? 0),
			...params.remove ? ["--remove"] : []
		], params.options);
	},
	async editMessage(params) {
		await runIMessageCliJson([
			"edit",
			"--chat",
			params.chatGuid,
			"--message",
			params.messageId,
			"--new-text",
			params.text,
			"--bc-text",
			params.backwardsCompatMessage ?? params.text,
			"--part",
			String(params.partIndex ?? 0)
		], params.options);
	},
	async unsendMessage(params) {
		await runIMessageCliJson([
			"unsend",
			"--chat",
			params.chatGuid,
			"--message",
			params.messageId,
			"--part",
			String(params.partIndex ?? 0)
		], params.options);
	},
	async sendRichMessage(params) {
		const formatted = extractMarkdownFormatRuns(params.text);
		const buildArgs = (filePath) => [
			"send-rich",
			"--chat",
			params.chatGuid,
			"--text",
			formatted.text,
			"--part",
			String(params.partIndex ?? 0),
			...params.effectId ? ["--effect", params.effectId] : [],
			...params.replyToMessageId ? ["--reply-to", params.replyToMessageId] : [],
			...formatted.ranges.length > 0 ? ["--format", JSON.stringify(formatted.ranges)] : [],
			...filePath ? ["--file", filePath] : []
		];
		if (params.attachment) return await withTempFile({
			buffer: params.attachment.buffer,
			filename: params.attachment.filename
		}, async (filePath) => {
			return { messageId: resolveMessageId(await runIMessageCliJson(buildArgs(filePath), params.options)) };
		});
		return { messageId: resolveMessageId(await runIMessageCliJson(buildArgs(), params.options)) };
	},
	async renameGroup(params) {
		await runIMessageCliJson([
			"chat-name",
			"--chat",
			params.chatGuid,
			"--name",
			params.displayName
		], params.options);
	},
	async setGroupIcon(params) {
		await withTempFile({
			buffer: params.buffer,
			filename: params.filename
		}, async (filePath) => {
			await runIMessageCliJson([
				"chat-photo",
				"--chat",
				params.chatGuid,
				"--file",
				filePath
			], params.options);
		});
	},
	async addParticipant(params) {
		await runIMessageCliJson([
			"chat-add-member",
			"--chat",
			params.chatGuid,
			"--address",
			params.address
		], params.options);
	},
	async removeParticipant(params) {
		await runIMessageCliJson([
			"chat-remove-member",
			"--chat",
			params.chatGuid,
			"--address",
			params.address
		], params.options);
	},
	async leaveGroup(params) {
		await runIMessageCliJson([
			"chat-leave",
			"--chat",
			params.chatGuid
		], params.options);
	},
	async sendAttachment(params) {
		return await withTempFile({
			buffer: params.buffer,
			filename: params.filename
		}, async (filePath) => {
			return { messageId: resolveMessageId(await runIMessageCliJson([
				"send-attachment",
				"--chat",
				params.chatGuid,
				"--file",
				filePath,
				...params.asVoice ? ["--audio"] : []
			], params.options)) };
		});
	}
};
//#endregion
export { findChatGuidForTest, imessageActionsRuntime, normalizeDirectChatIdentifierForTest };
