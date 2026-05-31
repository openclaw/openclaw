//#region src/session-interaction-mode.d.ts
type SessionInteractionEntry = {
  spawnedBy?: string;
  parentSessionKey?: string;
  acp?: unknown;
};
declare function isParentOwnedBackgroundAcpSession(entry?: SessionInteractionEntry | null): boolean;
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
declare function isRequesterParentOfBackgroundAcpSession(entry: SessionInteractionEntry | null | undefined, requesterSessionKey: string | null | undefined): boolean;
//#endregion
export { isParentOwnedBackgroundAcpSession, isRequesterParentOfBackgroundAcpSession };