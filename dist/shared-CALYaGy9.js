import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { i as normalizeConversationText, r as normalizeConversationTargetRef } from "./session-binding-normalization-D9PNZGcW.js";
import { f as supportsAutomaticThreadBindingSpawn } from "./thread-bindings-policy-BAuuUJk1.js";
import { a as resolveConversationBindingThreadIdFromMessage, n as resolveConversationBindingChannelFromMessage, r as resolveConversationBindingContextFromAcpCommand, t as resolveConversationBindingAccountIdFromMessage } from "./conversation-binding-input-CG40gdHa.js";
import { n as toAcpRuntimeErrorText } from "./error-text-DpXwhmkW.js";
import { randomUUID } from "node:crypto";
//#region src/auto-reply/reply/commands-acp/context.ts
function resolveAcpCommandChannel(params) {
	return normalizeLowercaseStringOrEmpty(normalizeConversationText(resolveConversationBindingChannelFromMessage(params.ctx, params.command.channel)));
}
function resolveAcpCommandAccountId(params) {
	return resolveConversationBindingAccountIdFromMessage({
		ctx: params.ctx,
		cfg: params.cfg,
		commandChannel: params.command.channel
	});
}
function resolveAcpCommandThreadId(params) {
	return resolveConversationBindingThreadIdFromMessage(params.ctx);
}
function resolveAcpCommandConversationRef(params) {
	const resolved = resolveConversationBindingContextFromAcpCommand(params);
	if (!resolved) return null;
	return normalizeConversationTargetRef({
		conversationId: resolved.conversationId,
		parentConversationId: resolved.parentConversationId
	});
}
function resolveAcpCommandConversationId(params) {
	return resolveAcpCommandConversationRef(params)?.conversationId;
}
function resolveAcpCommandBindingContext(params) {
	const conversationRef = resolveAcpCommandConversationRef(params);
	if (!conversationRef) return {
		channel: resolveAcpCommandChannel(params),
		accountId: resolveAcpCommandAccountId(params),
		threadId: resolveAcpCommandThreadId(params)
	};
	return {
		channel: resolveAcpCommandChannel(params),
		accountId: resolveAcpCommandAccountId(params),
		threadId: resolveAcpCommandThreadId(params),
		conversationId: conversationRef.conversationId,
		...conversationRef.parentConversationId ? { parentConversationId: conversationRef.parentConversationId } : {}
	};
}
//#endregion
//#region src/auto-reply/reply/commands-acp/shared.ts
const COMMAND = "/acp";
const ACP_SPAWN_USAGE = "Usage: /acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>].";
const ACP_STEER_USAGE = "Usage: /acp steer [--session <session-key|session-id|session-label>] <instruction>";
const ACP_SET_MODE_USAGE = "Usage: /acp set-mode <mode> [session-key|session-id|session-label]";
const ACP_SET_USAGE = "Usage: /acp set <key> <value> [session-key|session-id|session-label]";
const ACP_CWD_USAGE = "Usage: /acp cwd <path> [session-key|session-id|session-label]";
const ACP_PERMISSIONS_USAGE = "Usage: /acp permissions <profile> [session-key|session-id|session-label]";
const ACP_TIMEOUT_USAGE = "Usage: /acp timeout <seconds> [session-key|session-id|session-label]";
const ACP_MODEL_USAGE = "Usage: /acp model <model-id> [session-key|session-id|session-label]";
const ACP_RESET_OPTIONS_USAGE = "Usage: /acp reset-options [session-key|session-id|session-label]";
const ACP_STATUS_USAGE = "Usage: /acp status [session-key|session-id|session-label]";
const ACP_INSTALL_USAGE = "Usage: /acp install";
const ACP_DOCTOR_USAGE = "Usage: /acp doctor";
const ACP_SESSIONS_USAGE = "Usage: /acp sessions";
const ACP_UNICODE_DASH_PREFIX_RE = /^[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]+/;
function stopWithText(text) {
	return {
		shouldContinue: false,
		reply: { text }
	};
}
function resolveAcpAction(tokens) {
	const action = normalizeOptionalLowercaseString(tokens[0]);
	if (action === "spawn" || action === "cancel" || action === "steer" || action === "close" || action === "sessions" || action === "status" || action === "set-mode" || action === "set" || action === "cwd" || action === "permissions" || action === "timeout" || action === "model" || action === "reset-options" || action === "doctor" || action === "install" || action === "help") {
		tokens.shift();
		return action;
	}
	return "help";
}
function readOptionValue(params) {
	const token = normalizeAcpOptionToken(params.tokens[params.index] ?? "");
	if (token === params.flag) {
		const nextValue = normalizeAcpOptionToken(params.tokens[params.index + 1] ?? "");
		if (!nextValue || nextValue.startsWith("--")) return {
			matched: true,
			nextIndex: params.index + 1,
			error: `${params.flag} requires a value`
		};
		return {
			matched: true,
			value: nextValue,
			nextIndex: params.index + 2
		};
	}
	if (token.startsWith(`${params.flag}=`)) {
		const value = token.slice(`${params.flag}=`.length).trim();
		if (!value) return {
			matched: true,
			nextIndex: params.index + 1,
			error: `${params.flag} requires a value`
		};
		return {
			matched: true,
			value,
			nextIndex: params.index + 1
		};
	}
	return { matched: false };
}
function normalizeAcpOptionToken(raw) {
	const token = raw.trim();
	if (!token || token.startsWith("--")) return token;
	const dashPrefix = token.match(ACP_UNICODE_DASH_PREFIX_RE)?.[0];
	if (!dashPrefix) return token;
	return `--${token.slice(dashPrefix.length)}`;
}
function resolveDefaultSpawnThreadMode(params) {
	if (!supportsAutomaticThreadBindingSpawn(resolveAcpCommandChannel(params))) return "off";
	return resolveAcpCommandThreadId(params) ? "here" : "auto";
}
function parseSpawnInput(params, tokens) {
	const normalizedTokens = tokens.map((token) => normalizeAcpOptionToken(token));
	let mode = "persistent";
	let thread = resolveDefaultSpawnThreadMode(params);
	let sawThreadOption = false;
	let bind = "off";
	let cwd;
	let label;
	let rawAgentId;
	for (let i = 0; i < normalizedTokens.length;) {
		const token = normalizedTokens[i] ?? "";
		const modeOption = readOptionValue({
			tokens: normalizedTokens,
			index: i,
			flag: "--mode"
		});
		if (modeOption.matched) {
			if (modeOption.error) return {
				ok: false,
				error: `${modeOption.error}. ${ACP_SPAWN_USAGE}`
			};
			const raw = normalizeOptionalLowercaseString(modeOption.value);
			if (raw !== "persistent" && raw !== "oneshot") return {
				ok: false,
				error: `Invalid --mode value "${modeOption.value}". Use persistent or oneshot.`
			};
			mode = raw;
			i = modeOption.nextIndex;
			continue;
		}
		const bindOption = readOptionValue({
			tokens: normalizedTokens,
			index: i,
			flag: "--bind"
		});
		if (bindOption.matched) {
			if (bindOption.error) return {
				ok: false,
				error: `${bindOption.error}. ${ACP_SPAWN_USAGE}`
			};
			const raw = normalizeOptionalLowercaseString(bindOption.value);
			if (raw !== "here" && raw !== "off") return {
				ok: false,
				error: `Invalid --bind value "${bindOption.value}". Use here or off.`
			};
			bind = raw;
			i = bindOption.nextIndex;
			continue;
		}
		const threadOption = readOptionValue({
			tokens: normalizedTokens,
			index: i,
			flag: "--thread"
		});
		if (threadOption.matched) {
			if (threadOption.error) return {
				ok: false,
				error: `${threadOption.error}. ${ACP_SPAWN_USAGE}`
			};
			const raw = normalizeOptionalLowercaseString(threadOption.value);
			if (raw !== "auto" && raw !== "here" && raw !== "off") return {
				ok: false,
				error: `Invalid --thread value "${threadOption.value}". Use auto, here, or off.`
			};
			thread = raw;
			sawThreadOption = true;
			i = threadOption.nextIndex;
			continue;
		}
		const cwdOption = readOptionValue({
			tokens: normalizedTokens,
			index: i,
			flag: "--cwd"
		});
		if (cwdOption.matched) {
			if (cwdOption.error) return {
				ok: false,
				error: `${cwdOption.error}. ${ACP_SPAWN_USAGE}`
			};
			cwd = normalizeOptionalString(cwdOption.value);
			i = cwdOption.nextIndex;
			continue;
		}
		const labelOption = readOptionValue({
			tokens: normalizedTokens,
			index: i,
			flag: "--label"
		});
		if (labelOption.matched) {
			if (labelOption.error) return {
				ok: false,
				error: `${labelOption.error}. ${ACP_SPAWN_USAGE}`
			};
			label = normalizeOptionalString(labelOption.value);
			i = labelOption.nextIndex;
			continue;
		}
		if (token.startsWith("--")) return {
			ok: false,
			error: `Unknown option: ${token}. ${ACP_SPAWN_USAGE}`
		};
		if (!rawAgentId) {
			rawAgentId = normalizeOptionalString(token);
			i += 1;
			continue;
		}
		return {
			ok: false,
			error: `Unexpected argument: ${token}. ${ACP_SPAWN_USAGE}`
		};
	}
	const fallbackAgent = normalizeOptionalString(params.cfg.acp?.defaultAgent) ?? "";
	const selectedAgent = normalizeOptionalString(rawAgentId) ?? fallbackAgent;
	if (!selectedAgent) return {
		ok: false,
		error: `ACP target harness id is required. Pass an ACP harness id (for example codex) or configure acp.defaultAgent. ${ACP_SPAWN_USAGE}`
	};
	const normalizedAgentId = normalizeAgentId(selectedAgent);
	if (bind !== "off" && !sawThreadOption) thread = "off";
	if (thread !== "off" && bind !== "off") return {
		ok: false,
		error: `Use either --thread or --bind for /acp spawn, not both. ${ACP_SPAWN_USAGE}`
	};
	return {
		ok: true,
		value: {
			agentId: normalizedAgentId,
			mode,
			thread,
			bind,
			cwd,
			label
		}
	};
}
function parseSteerInput(tokens) {
	const normalizedTokens = tokens.map((token) => normalizeAcpOptionToken(token));
	let sessionToken;
	const instructionTokens = [];
	for (let i = 0; i < normalizedTokens.length;) {
		const sessionOption = readOptionValue({
			tokens: normalizedTokens,
			index: i,
			flag: "--session"
		});
		if (sessionOption.matched) {
			if (sessionOption.error) return {
				ok: false,
				error: `${sessionOption.error}. ${ACP_STEER_USAGE}`
			};
			sessionToken = normalizeOptionalString(sessionOption.value);
			i = sessionOption.nextIndex;
			continue;
		}
		instructionTokens.push(tokens[i] ?? "");
		i += 1;
	}
	const instruction = instructionTokens.join(" ").trim();
	if (!instruction) return {
		ok: false,
		error: ACP_STEER_USAGE
	};
	return {
		ok: true,
		value: {
			sessionToken,
			instruction
		}
	};
}
function parseSingleValueCommandInput(tokens, usage) {
	const value = normalizeOptionalString(tokens[0]) ?? "";
	if (!value) return {
		ok: false,
		error: usage
	};
	if (tokens.length > 2) return {
		ok: false,
		error: usage
	};
	return {
		ok: true,
		value: {
			value,
			sessionToken: normalizeOptionalString(tokens[1])
		}
	};
}
function parseSetCommandInput(tokens) {
	const key = normalizeOptionalString(tokens[0]) ?? "";
	const value = normalizeOptionalString(tokens[1]) ?? "";
	if (!key || !value) return {
		ok: false,
		error: ACP_SET_USAGE
	};
	if (tokens.length > 3) return {
		ok: false,
		error: ACP_SET_USAGE
	};
	return {
		ok: true,
		value: {
			key,
			value,
			sessionToken: normalizeOptionalString(tokens[2])
		}
	};
}
function parseOptionalSingleTarget(tokens, usage) {
	if (tokens.length > 1) return {
		ok: false,
		error: usage
	};
	const token = normalizeOptionalString(tokens[0]) ?? "";
	return {
		ok: true,
		...token ? { sessionToken: token } : {}
	};
}
function resolveAcpHelpText() {
	return [
		"ACP commands:",
		"-----",
		"/acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>]",
		"/acp cancel [session-key|session-id|session-label]",
		"/acp steer [--session <session-key|session-id|session-label>] <instruction>",
		"/acp close [session-key|session-id|session-label]",
		"/acp status [session-key|session-id|session-label]",
		"/acp set-mode <mode> [session-key|session-id|session-label]",
		"/acp set <key> <value> [session-key|session-id|session-label]",
		"/acp cwd <path> [session-key|session-id|session-label]",
		"/acp permissions <profile> [session-key|session-id|session-label]",
		"/acp timeout <seconds> [session-key|session-id|session-label]",
		"/acp model <model-id> [session-key|session-id|session-label]",
		"/acp reset-options [session-key|session-id|session-label]",
		"/acp doctor",
		"/acp install",
		"/acp sessions",
		"",
		"Notes:",
		"- /acp spawn harness-id is an ACP runtime harness alias (for example codex), not an OpenClaw agents.list id.",
		"- Use --bind here to pin the current conversation to the ACP session without creating a child thread.",
		"- /focus and /unfocus also work with ACP session keys.",
		"- ACP dispatch of normal thread messages is controlled by acp.dispatch.enabled."
	].join("\n");
}
function formatRuntimeOptionsText(options) {
	const extras = options.backendExtras ? Object.entries(options.backendExtras).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(", ") : "";
	const parts = [
		options.runtimeMode ? `runtimeMode=${options.runtimeMode}` : null,
		options.model ? `model=${options.model}` : null,
		options.cwd ? `cwd=${options.cwd}` : null,
		options.permissionProfile ? `permissionProfile=${options.permissionProfile}` : null,
		typeof options.timeoutSeconds === "number" ? `timeoutSeconds=${options.timeoutSeconds}` : null,
		extras ? `extras={${extras}}` : null
	].filter(Boolean);
	if (parts.length === 0) return "(none)";
	return parts.join(", ");
}
function formatAcpCapabilitiesText(controls) {
	if (controls.length === 0) return "(none)";
	return controls.toSorted().join(", ");
}
function resolveCommandRequestId(params) {
	const value = params.ctx.MessageSidFull ?? params.ctx.MessageSid ?? params.ctx.MessageSidFirst ?? params.ctx.MessageSidLast;
	if (typeof value === "string") {
		const normalizedValue = normalizeOptionalString(value);
		if (normalizedValue) return normalizedValue;
	}
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	return randomUUID();
}
function collectAcpErrorText(params) {
	return toAcpRuntimeErrorText({
		error: params.error,
		fallbackCode: params.fallbackCode,
		fallbackMessage: params.fallbackMessage
	});
}
async function withAcpCommandErrorBoundary(params) {
	try {
		const result = await params.run();
		return params.onSuccess(result);
	} catch (error) {
		return stopWithText(collectAcpErrorText({
			error,
			fallbackCode: params.fallbackCode,
			fallbackMessage: params.fallbackMessage
		}));
	}
}
//#endregion
export { stopWithText as C, resolveAcpCommandConversationId as D, resolveAcpCommandBindingContext as E, resolveAcpCommandThreadId as O, resolveCommandRequestId as S, resolveAcpCommandAccountId as T, parseSingleValueCommandInput as _, ACP_PERMISSIONS_USAGE as a, resolveAcpAction as b, ACP_SET_MODE_USAGE as c, COMMAND as d, collectAcpErrorText as f, parseSetCommandInput as g, parseOptionalSingleTarget as h, ACP_MODEL_USAGE as i, ACP_STATUS_USAGE as l, formatRuntimeOptionsText as m, ACP_DOCTOR_USAGE as n, ACP_RESET_OPTIONS_USAGE as o, formatAcpCapabilitiesText as p, ACP_INSTALL_USAGE as r, ACP_SESSIONS_USAGE as s, ACP_CWD_USAGE as t, ACP_TIMEOUT_USAGE as u, parseSpawnInput as v, withAcpCommandErrorBoundary as w, resolveAcpHelpText as x, parseSteerInput as y };
