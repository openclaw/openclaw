import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./account-id-B32J-iNN.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { n as formatThreadBindingSpawnDisabledError, t as formatThreadBindingDisabledError, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-BAuuUJk1.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./conversation-binding-runtime-Ch4mE9ps.js";
import "./conversation-runtime-guwDSNIo.js";
import { a as resolveMatrixTargetIdentity } from "./target-ids-CPjRklwl.js";
import { a as listBindingsForAccount, c as resolveBindingKey, i as listAllBindings, n as getMatrixThreadBindingManager, o as removeBindingRecord } from "./thread-bindings-shared-ZCOgSHlI.js";
//#region extensions/matrix/src/matrix/subagent-hooks.ts
function summarizeError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "error";
}
function resolveMatrixBindingThreadId(binding) {
	const { conversationId, parentConversationId } = binding.conversation;
	return parentConversationId && parentConversationId !== conversationId ? conversationId : void 0;
}
function resolveMatrixBindingDeliveryOrigin(binding, fallbackAccountId) {
	const boundRoomId = binding.conversation.parentConversationId ?? binding.conversation.conversationId;
	const threadId = resolveMatrixBindingThreadId(binding);
	return {
		channel: "matrix",
		accountId: binding.conversation.accountId ?? fallbackAccountId,
		to: `room:${boundRoomId}`,
		...threadId ? { threadId } : {}
	};
}
async function handleMatrixSubagentSpawning(api, event) {
	if (!event.threadRequested) return;
	if (event.requester?.channel?.trim().toLowerCase() !== "matrix") return;
	const accountId = normalizeOptionalString(event.requester?.accountId) || "default";
	const policy = resolveThreadBindingSpawnPolicy({
		cfg: api.config,
		channel: "matrix",
		accountId,
		kind: "subagent"
	});
	if (!policy.enabled) return {
		status: "error",
		error: formatThreadBindingDisabledError({
			channel: policy.channel,
			accountId: policy.accountId,
			kind: "subagent"
		})
	};
	if (!policy.spawnEnabled) return {
		status: "error",
		error: formatThreadBindingSpawnDisabledError({
			channel: policy.channel,
			accountId: policy.accountId,
			kind: "subagent"
		})
	};
	const rawTo = normalizeOptionalString(event.requester?.to) ?? "";
	const matrixTarget = rawTo ? resolveMatrixTargetIdentity(rawTo) : null;
	const roomId = matrixTarget?.kind === "room" ? matrixTarget.id : "";
	if (!roomId) return {
		status: "error",
		error: "Cannot create Matrix thread binding: no room target in spawn request (requester.to must be a Matrix room ID)."
	};
	const bindingService = getSessionBindingService();
	const capabilities = bindingService.getCapabilities({
		channel: "matrix",
		accountId
	});
	if (!capabilities.adapterAvailable || !capabilities.bindSupported) return {
		status: "error",
		error: `No Matrix session binding adapter available for account "${accountId}". Is the Matrix channel running?`
	};
	if (!capabilities.placements.includes("child")) return {
		status: "error",
		error: `Matrix session binding adapter for account "${accountId}" does not support child thread bindings.`
	};
	try {
		return {
			status: "ok",
			threadBindingReady: true,
			deliveryOrigin: resolveMatrixBindingDeliveryOrigin(await bindingService.bind({
				targetSessionKey: event.childSessionKey,
				targetKind: "subagent",
				conversation: {
					channel: "matrix",
					accountId,
					conversationId: roomId
				},
				placement: "child",
				metadata: {
					agentId: event.agentId?.trim() || void 0,
					label: normalizeOptionalString(event.label) || void 0,
					boundBy: "system"
				}
			}), accountId)
		};
	} catch (err) {
		return {
			status: "error",
			error: `Matrix thread bind failed: ${summarizeError(err)}`
		};
	}
}
async function handleMatrixSubagentEnded(event) {
	const accountId = normalizeOptionalString(event.accountId) || void 0;
	const matching = (accountId ? listBindingsForAccount(accountId) : listAllBindings()).filter((entry) => entry.targetSessionKey === event.targetSessionKey && entry.targetKind === "subagent");
	const removedBindingKeys = /* @__PURE__ */ new Set();
	if (event.sendFarewell) {
		const bindingService = getSessionBindingService();
		const reason = normalizeOptionalString(event.reason) || "subagent-ended";
		for (const binding of matching) {
			const bindingId = resolveBindingKey(binding);
			if ((await bindingService.unbind({
				bindingId,
				reason
			})).some((entry) => entry.bindingId === bindingId)) removedBindingKeys.add(bindingId);
		}
	}
	const affectedAccountIds = /* @__PURE__ */ new Set();
	for (const binding of matching) {
		if (removedBindingKeys.has(resolveBindingKey(binding))) continue;
		if (removeBindingRecord(binding)) affectedAccountIds.add(binding.accountId);
	}
	for (const acctId of affectedAccountIds) await getMatrixThreadBindingManager(acctId)?.persist();
}
function handleMatrixSubagentDeliveryTarget(event) {
	if (!event.expectsCompletionMessage) return;
	if (event.requesterOrigin?.channel?.trim().toLowerCase() !== "matrix") return;
	const requesterAccountId = normalizeOptionalString(event.requesterOrigin?.accountId);
	const requesterThreadId = event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== "" ? String(event.requesterOrigin.threadId).trim() : "";
	const bindings = (requesterAccountId ? listBindingsForAccount(requesterAccountId) : listAllBindings()).filter((entry) => entry.targetSessionKey === event.childSessionKey && entry.targetKind === "subagent");
	if (bindings.length === 0) return;
	let binding;
	if (requesterThreadId) binding = bindings.find((entry) => entry.conversationId === requesterThreadId && (!requesterAccountId || entry.accountId === requesterAccountId));
	if (!binding && bindings.length === 1) binding = bindings[0];
	if (!binding) return;
	const roomId = binding.parentConversationId ?? binding.conversationId;
	const threadId = binding.parentConversationId && binding.parentConversationId !== binding.conversationId ? binding.conversationId : void 0;
	return { origin: {
		channel: "matrix",
		accountId: binding.accountId,
		to: `room:${roomId}`,
		...threadId ? { threadId } : {}
	} };
}
//#endregion
export { handleMatrixSubagentEnded as n, handleMatrixSubagentSpawning as r, handleMatrixSubagentDeliveryTarget as t };
