import { i as jsonResult, n as resolveFetch, r as createActionGate, t as resolveReactionMessageId, u as readStringParam } from "../../../reaction-message-id-BNtk-P2G.js";
import "../../../utils-DZ2oAc5g.js";
import { t as loadConfig } from "../../../config-CpCccDYR.js";
import { n as fetchWithTimeout } from "../../../fetch-timeout-BshLAVgx.js";
import { i as resolveSignalAccount, n as resolveReactionLevel, r as listEnabledSignalAccounts, t as generateSecureUuid } from "../../../secure-random-Behs0EjU.js";

//#region src/signal/reaction-level.ts
/**
* Resolve the effective reaction level and its implications for Signal.
*
* Levels:
* - "off": No reactions at all
* - "ack": Only automatic ack reactions (👀 when processing), no agent reactions
* - "minimal": Agent can react, but sparingly (default)
* - "extensive": Agent can react liberally
*/
function resolveSignalReactionLevel(params) {
	return resolveReactionLevel({
		value: resolveSignalAccount({
			cfg: params.cfg,
			accountId: params.accountId
		}).config.reactionLevel,
		defaultLevel: "minimal",
		invalidFallback: "minimal"
	});
}

//#endregion
//#region src/signal/client.ts
const DEFAULT_TIMEOUT_MS = 1e4;
function normalizeBaseUrl(url) {
	const trimmed = url.trim();
	if (!trimmed) throw new Error("Signal base URL is required");
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
	return `http://${trimmed}`.replace(/\/+$/, "");
}
function getRequiredFetch() {
	const fetchImpl = resolveFetch();
	if (!fetchImpl) throw new Error("fetch is not available");
	return fetchImpl;
}
function parseSignalRpcResponse(text, status) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`Signal RPC returned malformed JSON (status ${status})`, { cause: err });
	}
	if (!parsed || typeof parsed !== "object") throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
	const rpc = parsed;
	const hasResult = Object.hasOwn(rpc, "result");
	if (!rpc.error && !hasResult) throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
	return rpc;
}
async function signalRpcRequest(method, params, opts) {
	const baseUrl = normalizeBaseUrl(opts.baseUrl);
	const id = generateSecureUuid();
	const body = JSON.stringify({
		jsonrpc: "2.0",
		method,
		params,
		id
	});
	const res = await fetchWithTimeout(`${baseUrl}/api/v1/rpc`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body
	}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, getRequiredFetch());
	if (res.status === 201) return;
	const text = await res.text();
	if (!text) throw new Error(`Signal RPC empty response (status ${res.status})`);
	const parsed = parseSignalRpcResponse(text, res.status);
	if (parsed.error) {
		const code = parsed.error.code ?? "unknown";
		const msg = parsed.error.message ?? "Signal RPC error";
		throw new Error(`Signal RPC ${code}: ${msg}`);
	}
	return parsed.result;
}

//#endregion
//#region src/signal/rpc-context.ts
function resolveSignalRpcContext(opts, accountInfo) {
	const hasBaseUrl = Boolean(opts.baseUrl?.trim());
	const hasAccount = Boolean(opts.account?.trim());
	const resolvedAccount = accountInfo || (!hasBaseUrl || !hasAccount ? resolveSignalAccount({
		cfg: loadConfig(),
		accountId: opts.accountId
	}) : void 0);
	const baseUrl = opts.baseUrl?.trim() || resolvedAccount?.baseUrl;
	if (!baseUrl) throw new Error("Signal base URL is required");
	return {
		baseUrl,
		account: opts.account?.trim() || resolvedAccount?.config.account?.trim()
	};
}

//#endregion
//#region src/signal/send-reactions.ts
/**
* Signal reactions via signal-cli JSON-RPC API
*/
function normalizeSignalId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	return trimmed.replace(/^signal:/i, "").trim();
}
function normalizeSignalUuid(raw) {
	const trimmed = normalizeSignalId(raw);
	if (!trimmed) return "";
	if (trimmed.toLowerCase().startsWith("uuid:")) return trimmed.slice(5).trim();
	return trimmed;
}
function resolveTargetAuthorParams(params) {
	const candidates = [
		params.targetAuthor,
		params.targetAuthorUuid,
		params.fallback
	];
	for (const candidate of candidates) {
		const raw = candidate?.trim();
		if (!raw) continue;
		const normalized = normalizeSignalUuid(raw);
		if (normalized) return { targetAuthor: normalized };
	}
	return {};
}
async function sendReactionSignalCore(params) {
	const accountInfo = resolveSignalAccount({
		cfg: params.opts.cfg ?? loadConfig(),
		accountId: params.opts.accountId
	});
	const { baseUrl, account } = resolveSignalRpcContext(params.opts, accountInfo);
	const normalizedRecipient = normalizeSignalUuid(params.recipient);
	const groupId = params.opts.groupId?.trim();
	if (!normalizedRecipient && !groupId) throw new Error(params.errors.missingRecipient);
	if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) throw new Error(params.errors.invalidTargetTimestamp);
	const normalizedEmoji = params.emoji?.trim();
	if (!normalizedEmoji) throw new Error(params.errors.missingEmoji);
	const targetAuthorParams = resolveTargetAuthorParams({
		targetAuthor: params.opts.targetAuthor,
		targetAuthorUuid: params.opts.targetAuthorUuid,
		fallback: normalizedRecipient
	});
	if (groupId && !targetAuthorParams.targetAuthor) throw new Error(params.errors.missingTargetAuthor);
	const requestParams = {
		emoji: normalizedEmoji,
		targetTimestamp: params.targetTimestamp,
		...params.remove ? { remove: true } : {},
		...targetAuthorParams
	};
	if (normalizedRecipient) requestParams.recipients = [normalizedRecipient];
	if (groupId) requestParams.groupIds = [groupId];
	if (account) requestParams.account = account;
	return {
		ok: true,
		timestamp: (await signalRpcRequest("sendReaction", requestParams, {
			baseUrl,
			timeoutMs: params.opts.timeoutMs
		}))?.timestamp
	};
}
/**
* Send a Signal reaction to a message
* @param recipient - UUID or E.164 phone number of the message author
* @param targetTimestamp - Message ID (timestamp) to react to
* @param emoji - Emoji to react with
* @param opts - Optional account/connection overrides
*/
async function sendReactionSignal(recipient, targetTimestamp, emoji, opts = {}) {
	return await sendReactionSignalCore({
		recipient,
		targetTimestamp,
		emoji,
		remove: false,
		opts,
		errors: {
			missingRecipient: "Recipient or groupId is required for Signal reaction",
			invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction",
			missingEmoji: "Emoji is required for Signal reaction",
			missingTargetAuthor: "targetAuthor is required for group reactions"
		}
	});
}
/**
* Remove a Signal reaction from a message
* @param recipient - UUID or E.164 phone number of the message author
* @param targetTimestamp - Message ID (timestamp) to remove reaction from
* @param emoji - Emoji to remove
* @param opts - Optional account/connection overrides
*/
async function removeReactionSignal(recipient, targetTimestamp, emoji, opts = {}) {
	return await sendReactionSignalCore({
		recipient,
		targetTimestamp,
		emoji,
		remove: true,
		opts,
		errors: {
			missingRecipient: "Recipient or groupId is required for Signal reaction removal",
			invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction removal",
			missingEmoji: "Emoji is required for Signal reaction removal",
			missingTargetAuthor: "targetAuthor is required for group reaction removal"
		}
	});
}

//#endregion
//#region src/channels/plugins/actions/signal.ts
const providerId = "signal";
const GROUP_PREFIX = "group:";
function normalizeSignalReactionRecipient(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
	if (!withoutSignal) return withoutSignal;
	if (withoutSignal.toLowerCase().startsWith("uuid:")) return withoutSignal.slice(5).trim();
	return withoutSignal;
}
function resolveSignalReactionTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
	if (!withoutSignal) return {};
	if (withoutSignal.toLowerCase().startsWith(GROUP_PREFIX)) {
		const groupId = withoutSignal.slice(6).trim();
		return groupId ? { groupId } : {};
	}
	return { recipient: normalizeSignalReactionRecipient(withoutSignal) };
}
async function mutateSignalReaction(params) {
	const options = {
		cfg: params.cfg,
		accountId: params.accountId,
		groupId: params.target.groupId,
		targetAuthor: params.targetAuthor,
		targetAuthorUuid: params.targetAuthorUuid
	};
	if (params.remove) {
		await removeReactionSignal(params.target.recipient ?? "", params.timestamp, params.emoji, options);
		return jsonResult({
			ok: true,
			removed: params.emoji
		});
	}
	await sendReactionSignal(params.target.recipient ?? "", params.timestamp, params.emoji, options);
	return jsonResult({
		ok: true,
		added: params.emoji
	});
}
const signalMessageActions = {
	listActions: ({ cfg }) => {
		const accounts = listEnabledSignalAccounts(cfg);
		if (accounts.length === 0) return [];
		const configuredAccounts = accounts.filter((account) => account.configured);
		if (configuredAccounts.length === 0) return [];
		const actions = new Set(["send"]);
		if (configuredAccounts.some((account) => createActionGate(account.config.actions)("reactions"))) actions.add("react");
		return Array.from(actions);
	},
	supportsAction: ({ action }) => action !== "send",
	handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
		if (action === "send") throw new Error("Send should be handled by outbound, not actions handler.");
		if (action === "react") {
			const reactionLevelInfo = resolveSignalReactionLevel({
				cfg,
				accountId: accountId ?? void 0
			});
			if (!reactionLevelInfo.agentReactionsEnabled) throw new Error(`Signal agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Set channels.signal.reactionLevel to "minimal" or "extensive" to enable.`);
			const actionConfig = resolveSignalAccount({
				cfg,
				accountId
			}).config.actions;
			if (!createActionGate(actionConfig)("reactions")) throw new Error("Signal reactions are disabled via actions.reactions.");
			const target = resolveSignalReactionTarget(readStringParam(params, "recipient") ?? readStringParam(params, "to", {
				required: true,
				label: "recipient (UUID, phone number, or group)"
			}));
			if (!target.recipient && !target.groupId) throw new Error("recipient or group required");
			const messageIdRaw = resolveReactionMessageId({
				args: params,
				toolContext
			});
			const messageId = messageIdRaw != null ? String(messageIdRaw) : void 0;
			if (!messageId) throw new Error("messageId (timestamp) required. Provide messageId explicitly or react to the current inbound message.");
			const targetAuthor = readStringParam(params, "targetAuthor");
			const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
			if (target.groupId && !targetAuthor && !targetAuthorUuid) throw new Error("targetAuthor or targetAuthorUuid required for group reactions.");
			const emoji = readStringParam(params, "emoji", { allowEmpty: true });
			const remove = typeof params.remove === "boolean" ? params.remove : void 0;
			const timestamp = parseInt(messageId, 10);
			if (!Number.isFinite(timestamp)) throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
			if (remove) {
				if (!emoji) throw new Error("Emoji required to remove reaction.");
				return await mutateSignalReaction({
					cfg,
					accountId: accountId ?? void 0,
					target,
					timestamp,
					emoji,
					remove: true,
					targetAuthor,
					targetAuthorUuid
				});
			}
			if (!emoji) throw new Error("Emoji required to add reaction.");
			return await mutateSignalReaction({
				cfg,
				accountId: accountId ?? void 0,
				target,
				timestamp,
				emoji,
				remove: false,
				targetAuthor,
				targetAuthorUuid
			});
		}
		throw new Error(`Action ${action} not supported for ${providerId}.`);
	}
};

//#endregion
export { signalMessageActions };