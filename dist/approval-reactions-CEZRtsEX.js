import { n as getOptionalMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
//#region extensions/matrix/src/approval-reactions.ts
const MATRIX_APPROVAL_REACTION_META = {
	"allow-once": {
		emoji: "✅",
		label: "Allow once"
	},
	"allow-always": {
		emoji: "♾️",
		label: "Allow always"
	},
	deny: {
		emoji: "❌",
		label: "Deny"
	}
};
const MATRIX_APPROVAL_REACTION_ORDER = [
	"allow-once",
	"allow-always",
	"deny"
];
const PERSISTENT_NAMESPACE = "matrix.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1e3;
const DEFAULT_REACTION_TARGET_TTL_MS = 1440 * 60 * 1e3;
const matrixApprovalReactionTargets = /* @__PURE__ */ new Map();
let persistentStore;
let persistentStoreDisabled = false;
function buildReactionTargetKey(roomId, eventId) {
	const normalizedRoomId = roomId.trim();
	const normalizedEventId = eventId.trim();
	if (!normalizedRoomId || !normalizedEventId) return null;
	return `${normalizedRoomId}:${normalizedEventId}`;
}
function reportPersistentApprovalReactionError(error) {
	try {
		getOptionalMatrixRuntime()?.logging.getChildLogger({
			plugin: "matrix",
			feature: "approval-reaction-state"
		}).warn("Matrix persistent approval reaction state failed", { error: String(error) });
	} catch {}
}
function disablePersistentApprovalReactionStore(error) {
	persistentStoreDisabled = true;
	persistentStore = void 0;
	reportPersistentApprovalReactionError(error);
}
function getPersistentApprovalReactionStore() {
	if (persistentStoreDisabled) return;
	if (persistentStore) return persistentStore;
	const runtime = getOptionalMatrixRuntime();
	if (!runtime) return;
	try {
		persistentStore = runtime.state.openKeyedStore({
			namespace: PERSISTENT_NAMESPACE,
			maxEntries: PERSISTENT_MAX_ENTRIES,
			defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS
		});
		return persistentStore;
	} catch (error) {
		disablePersistentApprovalReactionStore(error);
		return;
	}
}
function readPersistedTarget(value) {
	const persisted = value;
	if (persisted?.version !== 1 || !persisted.target || typeof persisted.target.approvalId !== "string" || !Array.isArray(persisted.target.allowedDecisions)) return null;
	return persisted.target;
}
function rememberPersistentApprovalReactionTarget(params) {
	const ttlMs = params.ttlMs == null ? DEFAULT_REACTION_TARGET_TTL_MS : Math.max(1, params.ttlMs);
	const store = getPersistentApprovalReactionStore();
	if (!store) return;
	store.register(params.key, {
		version: 1,
		target: params.target
	}, { ttlMs }).catch(disablePersistentApprovalReactionStore);
}
function forgetPersistentApprovalReactionTarget(key) {
	const store = getPersistentApprovalReactionStore();
	if (!store) return;
	store.delete(key).catch(disablePersistentApprovalReactionStore);
}
async function lookupPersistentApprovalReactionTarget(key) {
	const store = getPersistentApprovalReactionStore();
	if (!store) return null;
	try {
		return readPersistedTarget(await store.lookup(key));
	} catch (error) {
		disablePersistentApprovalReactionStore(error);
		return null;
	}
}
function listMatrixApprovalReactionBindings(allowedDecisions) {
	const allowed = new Set(allowedDecisions);
	return MATRIX_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map((decision) => ({
		decision,
		emoji: MATRIX_APPROVAL_REACTION_META[decision].emoji,
		label: MATRIX_APPROVAL_REACTION_META[decision].label
	}));
}
function buildMatrixApprovalReactionHint(allowedDecisions) {
	const bindings = listMatrixApprovalReactionBindings(allowedDecisions);
	if (bindings.length === 0) return null;
	return `React here: ${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join(", ")}`;
}
function resolveMatrixApprovalReactionDecision(reactionKey, allowedDecisions) {
	const normalizedReaction = reactionKey.trim();
	if (!normalizedReaction) return null;
	const allowed = new Set(allowedDecisions);
	for (const decision of MATRIX_APPROVAL_REACTION_ORDER) {
		if (!allowed.has(decision)) continue;
		if (MATRIX_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) return decision;
	}
	return null;
}
function registerMatrixApprovalReactionTarget(params) {
	const key = buildReactionTargetKey(params.roomId, params.eventId);
	const approvalId = params.approvalId.trim();
	const allowedDecisions = Array.from(new Set(params.allowedDecisions.filter((decision) => decision === "allow-once" || decision === "allow-always" || decision === "deny")));
	if (!key || !approvalId || allowedDecisions.length === 0) return;
	const target = {
		approvalId,
		allowedDecisions
	};
	matrixApprovalReactionTargets.set(key, target);
	rememberPersistentApprovalReactionTarget({
		key,
		target,
		ttlMs: params.ttlMs
	});
}
function unregisterMatrixApprovalReactionTarget(params) {
	const key = buildReactionTargetKey(params.roomId, params.eventId);
	if (!key) return;
	matrixApprovalReactionTargets.delete(key);
	forgetPersistentApprovalReactionTarget(key);
}
function resolveTarget(params) {
	const target = params.target;
	if (!target) return null;
	const decision = resolveMatrixApprovalReactionDecision(params.reactionKey, target.allowedDecisions);
	if (!decision) return null;
	return {
		approvalId: target.approvalId,
		decision
	};
}
async function resolveMatrixApprovalReactionTargetWithPersistence(params) {
	const key = buildReactionTargetKey(params.roomId, params.eventId);
	if (!key) return null;
	const inMemory = resolveTarget({
		target: matrixApprovalReactionTargets.get(key),
		reactionKey: params.reactionKey
	});
	if (inMemory) return inMemory;
	return resolveTarget({
		target: await lookupPersistentApprovalReactionTarget(key),
		reactionKey: params.reactionKey
	});
}
//#endregion
export { unregisterMatrixApprovalReactionTarget as a, resolveMatrixApprovalReactionTargetWithPersistence as i, listMatrixApprovalReactionBindings as n, registerMatrixApprovalReactionTarget as r, buildMatrixApprovalReactionHint as t };
