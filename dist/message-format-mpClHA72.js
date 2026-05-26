import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { t as getChatChannelMeta } from "./chat-meta-2H4wOcrq.js";
import "./registry-CtWyD2pE.js";
import { n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as formatTargetDisplay } from "./target-resolver-8NiS43Zp.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import { t as shortenText } from "./text-format-DFrLxXzb.js";
//#region src/infra/outbound/format.ts
const resolveChannelLabel$1 = (channel) => {
	const pluginLabel = getChannelPlugin(channel)?.meta.label;
	if (pluginLabel) return pluginLabel;
	const normalized = normalizeChatChannelId(channel);
	if (normalized) return getChatChannelMeta(normalized).label;
	return channel;
};
function formatOutboundDeliverySummary(channel, result) {
	if (!result) return `✅ Sent via ${resolveChannelLabel$1(channel)}. Message ID: unknown`;
	const base = `✅ Sent via ${resolveChannelLabel$1(result.channel)}. Message ID: ${result.messageId}`;
	if ("chatId" in result) return `${base} (chat ${result.chatId})`;
	if ("channelId" in result) return `${base} (channel ${result.channelId})`;
	if ("roomId" in result) return `${base} (room ${result.roomId})`;
	if ("conversationId" in result) return `${base} (conversation ${result.conversationId})`;
	return base;
}
function formatGatewaySummary(params) {
	return `✅ ${params.action ?? "Sent"} via gateway${params.channel ? ` (${params.channel})` : ""}. Message ID: ${params.messageId ?? "unknown"}`;
}
//#endregion
//#region src/commands/message-format.ts
const resolveChannelLabel = (channel) => getLoadedChannelPlugin(channel)?.meta.label ?? channel;
function extractMessageId(payload) {
	if (!payload || typeof payload !== "object") return null;
	const direct = payload.messageId;
	const directId = normalizeOptionalString(direct);
	if (directId) return directId;
	const result = payload.result;
	if (result && typeof result === "object") {
		const nested = result.messageId;
		const nestedId = normalizeOptionalString(nested);
		if (nestedId) return nestedId;
	}
	return null;
}
function renderObjectSummary(payload, opts) {
	if (!payload || typeof payload !== "object") return [String(payload)];
	const obj = payload;
	const keys = Object.keys(obj);
	if (keys.length === 0) return [theme.muted("(empty)")];
	const rows = keys.slice(0, 20).map((k) => {
		const v = obj[k];
		return {
			Key: k,
			Value: shortenText(v == null ? "null" : Array.isArray(v) ? `${v.length} items` : typeof v === "object" ? "object" : typeof v === "string" ? v : typeof v === "number" ? String(v) : typeof v === "boolean" ? v ? "true" : "false" : typeof v === "bigint" ? v.toString() : typeof v === "symbol" ? v.toString() : typeof v === "function" ? "function" : "unknown", 96)
		};
	});
	return [renderTable({
		width: opts.width,
		columns: [{
			key: "Key",
			header: "Key",
			minWidth: 16
		}, {
			key: "Value",
			header: "Value",
			flex: true,
			minWidth: 24
		}],
		rows
	}).trimEnd()];
}
function renderMessageList(messages, opts, emptyLabel) {
	const rows = messages.slice(0, 25).map((m) => {
		const msg = m;
		const id = typeof msg.id === "string" && msg.id || typeof msg.ts === "string" && msg.ts || typeof msg.messageId === "string" && msg.messageId || "";
		const authorObj = msg.author;
		const author = typeof msg.authorTag === "string" && msg.authorTag || typeof authorObj?.username === "string" && authorObj.username || typeof msg.user === "string" && msg.user || "";
		const time = typeof msg.timestamp === "string" && msg.timestamp || typeof msg.ts === "string" && msg.ts || "";
		const text = typeof msg.content === "string" && msg.content || typeof msg.text === "string" && msg.text || "";
		return {
			Time: shortenText(time, 28),
			Author: shortenText(author, 22),
			Text: shortenText(text.replace(/\s+/g, " ").trim(), 90),
			Id: shortenText(id, 22)
		};
	});
	if (rows.length === 0) return [theme.muted(emptyLabel)];
	return [renderTable({
		width: opts.width,
		columns: [
			{
				key: "Time",
				header: "Time",
				minWidth: 14
			},
			{
				key: "Author",
				header: "Author",
				minWidth: 10
			},
			{
				key: "Text",
				header: "Text",
				flex: true,
				minWidth: 24
			},
			{
				key: "Id",
				header: "Id",
				minWidth: 10
			}
		],
		rows
	}).trimEnd()];
}
function renderMessagesFromPayload(payload, opts) {
	if (!payload || typeof payload !== "object") return null;
	const messages = payload.messages;
	if (!Array.isArray(messages)) return null;
	return renderMessageList(messages, opts, "No messages.");
}
function renderPinsFromPayload(payload, opts) {
	if (!payload || typeof payload !== "object") return null;
	const pins = payload.pins;
	if (!Array.isArray(pins)) return null;
	return renderMessageList(pins, opts, "No pins.");
}
function extractDiscordSearchResultsMessages(results) {
	if (!results || typeof results !== "object") return null;
	const raw = results.messages;
	if (!Array.isArray(raw)) return null;
	const flattened = [];
	for (const entry of raw) if (Array.isArray(entry) && entry.length > 0) flattened.push(entry[0]);
	else if (entry && typeof entry === "object") flattened.push(entry);
	return flattened.length ? flattened : null;
}
function renderReactions(payload, opts) {
	if (!payload || typeof payload !== "object") return null;
	const reactions = payload.reactions;
	if (!Array.isArray(reactions)) return null;
	const rows = reactions.slice(0, 50).map((r) => {
		const entry = r;
		const emojiObj = entry.emoji;
		return {
			Emoji: typeof emojiObj?.raw === "string" && emojiObj.raw || typeof entry.name === "string" && entry.name || typeof entry.emoji === "string" && entry.emoji || "",
			Count: typeof entry.count === "number" ? String(entry.count) : "",
			Users: shortenText((Array.isArray(entry.users) ? entry.users.slice(0, 8).map((u) => {
				if (typeof u === "string") return u;
				if (!u || typeof u !== "object") return "";
				const user = u;
				return typeof user.tag === "string" && user.tag || typeof user.username === "string" && user.username || typeof user.id === "string" && user.id || "";
			}).filter(Boolean) : []).join(", "), 72)
		};
	});
	if (rows.length === 0) return [theme.muted("No reactions.")];
	return [renderTable({
		width: opts.width,
		columns: [
			{
				key: "Emoji",
				header: "Emoji",
				minWidth: 8
			},
			{
				key: "Count",
				header: "Count",
				align: "right",
				minWidth: 6
			},
			{
				key: "Users",
				header: "Users",
				flex: true,
				minWidth: 20
			}
		],
		rows
	}).trimEnd()];
}
function formatMessageCliText(result) {
	const rich = isRich();
	const ok = (text) => rich ? theme.success(text) : text;
	const muted = (text) => rich ? theme.muted(text) : text;
	const heading = (text) => rich ? theme.heading(text) : text;
	const opts = { width: getTerminalTableWidth() };
	if (result.handledBy === "dry-run") return [muted(`[dry-run] would run ${result.action} via ${result.channel}`)];
	if (result.kind === "broadcast") {
		const results = result.payload.results ?? [];
		const rows = results.map((entry) => ({
			Channel: resolveChannelLabel(entry.channel),
			Target: shortenText(formatTargetDisplay({
				channel: entry.channel,
				target: entry.to
			}), 36),
			Status: entry.ok ? "ok" : "error",
			Error: entry.ok ? "" : shortenText(entry.error ?? "unknown error", 48)
		}));
		const okCount = results.filter((entry) => entry.ok).length;
		const total = results.length;
		return [ok(`✅ Broadcast complete (${okCount}/${total} succeeded, ${total - okCount} failed)`), renderTable({
			width: opts.width,
			columns: [
				{
					key: "Channel",
					header: "Channel",
					minWidth: 10
				},
				{
					key: "Target",
					header: "Target",
					minWidth: 12,
					flex: true
				},
				{
					key: "Status",
					header: "Status",
					minWidth: 6
				},
				{
					key: "Error",
					header: "Error",
					minWidth: 20,
					flex: true
				}
			],
			rows: rows.slice(0, 50)
		}).trimEnd()];
	}
	if (result.kind === "send") {
		if (result.handledBy === "core" && result.sendResult) {
			const send = result.sendResult;
			if (send.via === "direct") {
				const directResult = send.result;
				return [ok(formatOutboundDeliverySummary(send.channel, directResult))];
			}
			const gatewayResult = send.result;
			return [ok(formatGatewaySummary({
				channel: send.channel,
				messageId: gatewayResult?.messageId ?? null
			}))];
		}
		const label = resolveChannelLabel(result.channel);
		const msgId = extractMessageId(result.payload);
		return [ok(`✅ Sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
	}
	if (result.kind === "poll") {
		if (result.handledBy === "core" && result.pollResult) {
			const poll = result.pollResult;
			const pollId = poll.result?.pollId;
			const msgId = poll.result?.messageId ?? null;
			const lines = [ok(formatGatewaySummary({
				action: "Poll sent",
				channel: poll.channel,
				messageId: msgId
			}))];
			if (pollId) lines.push(ok(`Poll id: ${pollId}`));
			return lines;
		}
		const label = resolveChannelLabel(result.channel);
		const msgId = extractMessageId(result.payload);
		return [ok(`✅ Poll sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
	}
	const payload = result.payload;
	const lines = [];
	if (result.action === "react") {
		const added = payload.added;
		const removed = payload.removed;
		if (typeof added === "string" && added.trim()) {
			lines.push(ok(`✅ Reaction added: ${added.trim()}`));
			return lines;
		}
		if (typeof removed === "string" && removed.trim()) {
			lines.push(ok(`✅ Reaction removed: ${removed.trim()}`));
			return lines;
		}
		if (Array.isArray(removed)) {
			const list = normalizeStringEntries(removed).join(", ");
			lines.push(ok(`✅ Reactions removed${list ? `: ${list}` : ""}`));
			return lines;
		}
		lines.push(ok("✅ Reaction updated."));
		return lines;
	}
	const reactionsTable = renderReactions(payload, opts);
	if (reactionsTable && result.action === "reactions") {
		lines.push(heading("Reactions"));
		lines.push(reactionsTable[0] ?? "");
		return lines;
	}
	if (result.action === "read") {
		const messagesTable = renderMessagesFromPayload(payload, opts);
		if (messagesTable) {
			lines.push(heading("Messages"));
			lines.push(messagesTable[0] ?? "");
			return lines;
		}
	}
	if (result.action === "list-pins") {
		const pinsTable = renderPinsFromPayload(payload, opts);
		if (pinsTable) {
			lines.push(heading("Pinned messages"));
			lines.push(pinsTable[0] ?? "");
			return lines;
		}
	}
	if (result.action === "search") {
		const results = payload.results;
		const list = extractDiscordSearchResultsMessages(results);
		if (list) {
			lines.push(heading("Search results"));
			lines.push(renderMessageList(list, opts, "No results.")[0] ?? "");
			return lines;
		}
	}
	lines.push(ok(`✅ ${result.action} via ${resolveChannelLabel(result.channel)}.`));
	const summary = renderObjectSummary(payload, opts);
	if (summary.length) {
		lines.push("");
		lines.push(...summary);
		lines.push("");
		lines.push(muted("Tip: use --json for full output."));
	}
	return lines;
}
//#endregion
export { formatMessageCliText };
