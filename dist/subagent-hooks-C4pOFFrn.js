import { l as normalizeOptionalStringifiedId, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as formatThreadBindingSpawnDisabledError, t as formatThreadBindingDisabledError, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-BAuuUJk1.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./conversation-runtime-guwDSNIo.js";
import { s as resolveDiscordAccount } from "./accounts-DIRzXd2H.js";
import { a as unbindThreadBindingsBySessionKey, n as listThreadBindingsBySessionKey, t as autoBindSpawnedDiscordSubagent } from "./thread-bindings-DFnH__lt.js";
//#region extensions/discord/src/subagent-hooks.ts
function summarizeError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "error";
}
function normalizeThreadBindingTargetKind(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized === "subagent" || normalized === "acp") return normalized;
}
async function handleDiscordSubagentSpawning(api, event) {
	if (!event.threadRequested) return;
	if (normalizeOptionalLowercaseString(event.requester?.channel) !== "discord") return;
	const account = resolveDiscordAccount({
		cfg: api.config,
		accountId: event.requester?.accountId
	});
	const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
		cfg: api.config,
		channel: "discord",
		accountId: account.accountId,
		kind: "subagent"
	});
	if (!threadBindingPolicy.enabled) return {
		status: "error",
		error: formatThreadBindingDisabledError({
			channel: threadBindingPolicy.channel,
			accountId: threadBindingPolicy.accountId,
			kind: "subagent"
		})
	};
	if (!threadBindingPolicy.spawnEnabled) return {
		status: "error",
		error: formatThreadBindingSpawnDisabledError({
			channel: threadBindingPolicy.channel,
			accountId: threadBindingPolicy.accountId,
			kind: "subagent"
		})
	};
	try {
		const agentId = event.agentId?.trim() || "subagent";
		const binding = await autoBindSpawnedDiscordSubagent({
			cfg: api.config,
			accountId: account.accountId,
			channel: event.requester?.channel,
			to: event.requester?.to,
			threadId: event.requester?.threadId,
			childSessionKey: event.childSessionKey,
			agentId,
			label: event.label,
			boundBy: "system"
		});
		if (!binding) return {
			status: "error",
			error: "Unable to create or bind a Discord thread for this subagent session. Session mode is unavailable for this target."
		};
		return {
			status: "ok",
			threadBindingReady: true,
			deliveryOrigin: {
				channel: "discord",
				accountId: account.accountId,
				to: `channel:${binding.threadId}`,
				threadId: binding.threadId
			}
		};
	} catch (err) {
		return {
			status: "error",
			error: `Discord thread bind failed: ${summarizeError(err)}`
		};
	}
}
function handleDiscordSubagentEnded(event) {
	unbindThreadBindingsBySessionKey({
		targetSessionKey: event.targetSessionKey,
		accountId: event.accountId,
		targetKind: normalizeThreadBindingTargetKind(event.targetKind),
		reason: event.reason,
		sendFarewell: event.sendFarewell
	});
}
function handleDiscordSubagentDeliveryTarget(event) {
	if (!event.expectsCompletionMessage) return;
	if (normalizeOptionalLowercaseString(event.requesterOrigin?.channel) !== "discord") return;
	const requesterAccountId = event.requesterOrigin?.accountId?.trim();
	const requesterThreadId = event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== "" ? normalizeOptionalStringifiedId(event.requesterOrigin.threadId) ?? "" : "";
	const bindings = listThreadBindingsBySessionKey({
		targetSessionKey: event.childSessionKey,
		...requesterAccountId ? { accountId: requesterAccountId } : {},
		targetKind: "subagent"
	});
	if (bindings.length === 0) return;
	let binding;
	if (requesterThreadId) binding = bindings.find((entry) => {
		if (entry.threadId !== requesterThreadId) return false;
		if (requesterAccountId && entry.accountId !== requesterAccountId) return false;
		return true;
	});
	if (!binding && bindings.length === 1) binding = bindings[0];
	if (!binding) return;
	return { origin: {
		channel: "discord",
		accountId: binding.accountId,
		to: `channel:${binding.threadId}`,
		threadId: binding.threadId
	} };
}
//#endregion
export { handleDiscordSubagentEnded as n, handleDiscordSubagentSpawning as r, handleDiscordSubagentDeliveryTarget as t };
