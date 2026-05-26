import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { createHash } from "node:crypto";
//#region src/infra/outbound/pending-spawn-query.ts
const log = createSubsystemLogger("outbound/pending-spawn");
const THROW_LOG_INTERVAL_MS = 6e4;
let lastThrowLogAt = 0;
let pendingSpawnedChildrenQuery;
function registerPendingSpawnedChildrenQuery(query) {
	const previous = pendingSpawnedChildrenQuery;
	pendingSpawnedChildrenQuery = query;
	return previous;
}
function summarizeError(err) {
	if (err instanceof Error) return {
		name: err.name,
		message: err.message
	};
	return {
		name: "Unknown",
		message: typeof err === "string" ? err : "non-error throw"
	};
}
function hashSessionKey(key) {
	const trimmed = key?.trim();
	if (!trimmed) return;
	return createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}
function resolvePendingSpawnedChildren(sessionKey) {
	if (!pendingSpawnedChildrenQuery) return false;
	try {
		return pendingSpawnedChildrenQuery(sessionKey);
	} catch (err) {
		const now = Date.now();
		if (now - lastThrowLogAt >= THROW_LOG_INTERVAL_MS) {
			lastThrowLogAt = now;
			log.warn("pending-spawn query threw; defaulting to false", {
				err: summarizeError(err),
				sessionKeyHash: hashSessionKey(sessionKey)
			});
		}
		return false;
	}
}
//#endregion
export { resolvePendingSpawnedChildren as n, registerPendingSpawnedChildrenQuery as t };
