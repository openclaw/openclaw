import { C as hasSessionAutoModelFallbackProvenance } from "./agent-scope-CtLXGcWm.js";
import { r as drainSystemEventEntries } from "./system-events-11EG3LzK.js";
import { a as clearSessionQueues } from "./queue-DskPlua9.js";
//#region src/auto-reply/reply/session-reset-cleanup.ts
function clearSessionResetRuntimeState(keys) {
	const cleared = clearSessionQueues(keys);
	let systemEventsCleared = 0;
	for (const key of cleared.keys) systemEventsCleared += drainSystemEventEntries(key).length;
	return {
		...cleared,
		systemEventsCleared
	};
}
//#endregion
//#region src/config/sessions/reset-preserved-selection.ts
/**
* Decide which model/provider/auth overrides survive a `/new` or `/reset`.
*
* Only user-driven overrides (explicit `/model`, `sessions.patch`, etc.) are
* preserved. Auto-created overrides (runtime fallbacks, rate-limit rotations)
* are cleared so resets actually return the session to the configured default.
*
* Legacy entries persisted before `modelOverrideSource` was tracked are
* treated as user-driven, matching the prior reset behavior so explicit
* selections made before the source field existed are not silently dropped.
*/
function resolveResetPreservedSelection(params) {
	const { entry } = params;
	if (!entry) return {};
	const preserved = {};
	const recoveredAutoFallbackOverride = entry.modelOverrideSource === void 0 && hasSessionAutoModelFallbackProvenance(entry);
	if ((entry.modelOverrideSource === "user" || entry.modelOverrideSource === void 0 && Boolean(entry.modelOverride) && !recoveredAutoFallbackOverride) && entry.modelOverride) {
		preserved.providerOverride = entry.providerOverride;
		preserved.modelOverride = entry.modelOverride;
		preserved.modelOverrideSource = "user";
	}
	if (entry.authProfileOverrideSource === "user" && entry.authProfileOverride) {
		preserved.authProfileOverride = entry.authProfileOverride;
		preserved.authProfileOverrideSource = entry.authProfileOverrideSource;
		if (entry.authProfileOverrideCompactionCount !== void 0) preserved.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
	}
	return preserved;
}
//#endregion
export { clearSessionResetRuntimeState as n, resolveResetPreservedSelection as t };
