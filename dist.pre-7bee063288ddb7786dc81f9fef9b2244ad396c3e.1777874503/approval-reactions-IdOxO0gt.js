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
const matrixApprovalReactionTargets = /* @__PURE__ */ new Map();
function buildReactionTargetKey(roomId, eventId) {
	const normalizedRoomId = roomId.trim();
	const normalizedEventId = eventId.trim();
	if (!normalizedRoomId || !normalizedEventId) return null;
	return `${normalizedRoomId}:${normalizedEventId}`;
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
	matrixApprovalReactionTargets.set(key, {
		approvalId,
		allowedDecisions
	});
}
function unregisterMatrixApprovalReactionTarget(params) {
	const key = buildReactionTargetKey(params.roomId, params.eventId);
	if (!key) return;
	matrixApprovalReactionTargets.delete(key);
}
function resolveMatrixApprovalReactionTarget(params) {
	const key = buildReactionTargetKey(params.roomId, params.eventId);
	if (!key) return null;
	const target = matrixApprovalReactionTargets.get(key);
	if (!target) return null;
	const decision = resolveMatrixApprovalReactionDecision(params.reactionKey, target.allowedDecisions);
	if (!decision) return null;
	return {
		approvalId: target.approvalId,
		decision
	};
}
//#endregion
export { unregisterMatrixApprovalReactionTarget as a, resolveMatrixApprovalReactionTarget as i, listMatrixApprovalReactionBindings as n, registerMatrixApprovalReactionTarget as r, buildMatrixApprovalReactionHint as t };
