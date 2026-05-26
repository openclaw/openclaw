import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { t as getActivePluginChannelRegistry } from "./runtime-DHxRl5F1.js";
import { a as isNativeCommandTurn, s as resolveCommandTurnContext } from "./command-turn-context-BiMylvBj.js";
import { n as extractTextFromChatContent } from "./chat-content-BNTcXm1Z.js";
import { M as subagentRuns, l as countPendingDescendantRunsFromRuns, t as getSubagentRunsSnapshotForRead } from "./subagent-registry-state-DbOPrqYx.js";
import { n as resolveStoredSubagentCapabilities } from "./subagent-capabilities-mB73wM9t.js";
import { n as looksLikeSessionId } from "./session-id-MQsocdDH.js";
import { c as resolveMainSessionAlias, s as resolveInternalSessionKey } from "./sessions-helpers-AhiZZPDz.js";
import { n as sanitizeTextContent } from "./chat-history-text-BaMeG8tt.js";
import { i as resolveSubagentTargetFromRuns, t as formatRunLabel } from "./subagents-utils-B4IBbOXw.js";
//#region src/auto-reply/reply/channel-context.ts
function resolveCommandSurfaceChannel(params) {
	return normalizeOptionalLowercaseString(params.ctx.OriginatingChannel ?? params.command.channel ?? params.ctx.Surface ?? params.ctx.Provider) ?? "";
}
function resolveChannelAccountId(params) {
	const accountId = normalizeOptionalString(params.ctx.AccountId) ?? "";
	if (accountId) return accountId;
	const channel = resolveCommandSurfaceChannel(params);
	const plugin = getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === channel)?.plugin;
	return normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg)) || "default";
}
//#endregion
//#region src/auto-reply/reply/commands-subagents-text.ts
function extractMessageText(message) {
	const role = typeof message.role === "string" ? message.role : "";
	const shouldSanitize = role === "assistant";
	const text = extractTextFromChatContent(message.content, { sanitizeText: shouldSanitize ? sanitizeTextContent : void 0 });
	return text ? {
		role,
		text
	} : null;
}
//#endregion
//#region src/auto-reply/reply/commands-subagents/shared.ts
const COMMAND = "/subagents";
const COMMAND_KILL = "/kill";
const COMMAND_FOCUS = "/focus";
const COMMAND_UNFOCUS = "/unfocus";
const COMMAND_AGENTS = "/agents";
const ACTIONS = new Set([
	"list",
	"kill",
	"log",
	"send",
	"steer",
	"info",
	"spawn",
	"focus",
	"unfocus",
	"agents",
	"help"
]);
function stopWithText(text) {
	return {
		shouldContinue: false,
		reply: { text }
	};
}
function stopWithUnknownTargetError(error) {
	return stopWithText(`⚠️ ${error ?? "Unknown subagent."}`);
}
function resolveSubagentTarget(runs, token) {
	return resolveSubagentTargetFromRuns({
		runs,
		token,
		recentWindowMinutes: 30,
		label: (entry) => formatRunLabel(entry),
		aliases: (entry) => entry.taskName ? [entry.taskName] : [],
		isActive: (entry) => !entry.endedAt || Math.max(0, countPendingDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), entry.childSessionKey)) > 0,
		errors: {
			missingTarget: "Missing subagent id.",
			invalidIndex: (value) => `Invalid subagent index: ${value}`,
			unknownSession: (value) => `Unknown subagent session: ${value}`,
			ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
			ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
			ambiguousRunIdPrefix: (value) => `Ambiguous run id prefix: ${value}`,
			unknownTarget: (value) => `Unknown subagent id: ${value}`
		}
	});
}
function resolveSubagentEntryForToken(runs, token) {
	const resolved = resolveSubagentTarget(runs, token);
	if (!resolved.entry) return { reply: stopWithUnknownTargetError(resolved.error) };
	return { entry: resolved.entry };
}
function resolveRequesterSessionKey(params, opts) {
	const commandTarget = normalizeOptionalString(params.ctx.CommandTargetSessionKey);
	const commandSession = normalizeOptionalString(params.sessionKey);
	const raw = opts?.preferCommandTarget ?? isNativeCommandTurn(resolveCommandTurnContext(params.ctx)) ? commandTarget || commandSession : commandSession || commandTarget;
	if (!raw) return;
	const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
	return resolveInternalSessionKey({
		key: raw,
		alias,
		mainKey
	});
}
function resolveCommandSubagentController(params, requesterKey) {
	if (!isSubagentSessionKey(requesterKey)) return {
		controllerSessionKey: requesterKey,
		callerSessionKey: requesterKey,
		callerIsSubagent: false,
		controlScope: "children"
	};
	return {
		controllerSessionKey: requesterKey,
		callerSessionKey: requesterKey,
		callerIsSubagent: true,
		controlScope: resolveStoredSubagentCapabilities(requesterKey, { cfg: params.cfg }).controlScope
	};
}
function resolveHandledPrefix(normalized) {
	return normalized.startsWith("/subagents") ? COMMAND : normalized.startsWith("/kill") ? COMMAND_KILL : normalized.startsWith(COMMAND_FOCUS) ? COMMAND_FOCUS : normalized.startsWith(COMMAND_UNFOCUS) ? COMMAND_UNFOCUS : normalized.startsWith(COMMAND_AGENTS) ? COMMAND_AGENTS : null;
}
function resolveSubagentsAction(params) {
	if (params.handledPrefix === "/subagents") {
		const [actionRaw] = params.restTokens;
		const action = normalizeLowercaseStringOrEmpty(actionRaw) || "list";
		if (!ACTIONS.has(action)) return null;
		params.restTokens.splice(0, 1);
		return action;
	}
	if (params.handledPrefix === "/kill") return "kill";
	if (params.handledPrefix === COMMAND_FOCUS) return "focus";
	if (params.handledPrefix === COMMAND_UNFOCUS) return "unfocus";
	if (params.handledPrefix === COMMAND_AGENTS) return "agents";
	return null;
}
async function resolveFocusTargetSession(params) {
	const subagentMatch = resolveSubagentTarget(params.runs, params.token);
	if (subagentMatch.entry) {
		const key = subagentMatch.entry.childSessionKey;
		return {
			targetKind: "subagent",
			targetSessionKey: key,
			agentId: parseAgentSessionKey(key)?.agentId ?? "main",
			label: formatRunLabel(subagentMatch.entry)
		};
	}
	const token = params.token.trim();
	if (!token) return null;
	const attempts = [];
	const requesterKey = normalizeOptionalString(params.requesterKey);
	const spawnedBy = requesterKey && isSubagentSessionKey(requesterKey) ? requesterKey : void 0;
	attempts.push({ key: token });
	if (looksLikeSessionId(token)) attempts.push({ sessionId: token });
	attempts.push({ label: token });
	for (const attempt of attempts) try {
		const key = normalizeOptionalString((await callGateway({
			method: "sessions.resolve",
			params: spawnedBy ? {
				...attempt,
				spawnedBy
			} : attempt
		}))?.key) ?? "";
		if (!key) continue;
		const parsed = parseAgentSessionKey(key);
		return {
			targetKind: key.includes(":subagent:") ? "subagent" : "acp",
			targetSessionKey: key,
			agentId: parsed?.agentId ?? "main",
			label: token
		};
	} catch {}
	return null;
}
function buildSubagentsHelp() {
	return [
		"Subagents",
		"Usage:",
		"- /subagents list",
		"- /subagents kill <id|#|all>",
		"- /subagents log <id|#> [limit] [tools]",
		"- /subagents info <id|#>",
		"- /subagents send <id|#> <message>",
		"- /subagents steer <id|#> <message>",
		"- /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
		"- /focus <subagent-label|session-key|session-id|session-label>",
		"- /unfocus",
		"- /agents",
		"- /session idle <duration|off>",
		"- /session max-age <duration|off>",
		"- /kill <id|#|all>",
		"",
		"Ids: use the list index (#), runId/session prefix, label, or full session key."
	].join("\n");
}
function formatLogLines(messages) {
	const lines = [];
	for (const msg of messages) {
		const extracted = extractMessageText(msg);
		if (!extracted) continue;
		const label = extracted.role === "assistant" ? "Assistant" : "User";
		lines.push(`${label}: ${extracted.text}`);
	}
	return lines;
}
//#endregion
export { resolveFocusTargetSession as a, resolveSubagentEntryForToken as c, resolveChannelAccountId as d, resolveCommandSurfaceChannel as f, resolveCommandSubagentController as i, resolveSubagentsAction as l, buildSubagentsHelp as n, resolveHandledPrefix as o, formatLogLines as r, resolveRequesterSessionKey as s, COMMAND as t, stopWithText as u };
