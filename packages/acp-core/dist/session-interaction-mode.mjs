import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
//#region src/session-interaction-mode.ts
function resolveAcpSessionInteractionMode(entry) {
	if (!entry?.acp) return "interactive";
	if (normalizeOptionalString(entry.spawnedBy) || normalizeOptionalString(entry.parentSessionKey)) return "parent-owned-background";
	return "interactive";
}
function isParentOwnedBackgroundAcpSession(entry) {
	return resolveAcpSessionInteractionMode(entry) === "parent-owned-background";
}
/**
* Returns true when `entry` is a parent-owned background ACP session AND the
* given `requesterSessionKey` is the session that spawned/owns it. This is a
* strictly narrower check than {@link isParentOwnedBackgroundAcpSession}: the
* target must match *and* the caller must be the parent.
*
* Used to gate behaviors that only make sense for the parent↔own-child pair
* (e.g. skipping the A2A ping-pong flow in `sessions_send`), so that an
* unrelated session with broad visibility (e.g. `tools.sessions.visibility=all`)
* sending to the same target is still routed through the normal A2A path.
*/
function isRequesterParentOfBackgroundAcpSession(entry, requesterSessionKey) {
	if (!isParentOwnedBackgroundAcpSession(entry)) return false;
	const requester = normalizeOptionalString(requesterSessionKey);
	if (!requester) return false;
	const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
	const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
	return requester === spawnedBy || requester === parentSessionKey;
}
//#endregion
export { isParentOwnedBackgroundAcpSession, isRequesterParentOfBackgroundAcpSession };
