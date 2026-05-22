import type { SessionEntry } from "../config/sessions/types.js";
import { type EmbeddedRunModelSwitchRequest } from "./pi-embedded-runner/runs.js";
export { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
export type LiveSessionModelSelection = EmbeddedRunModelSwitchRequest;
export declare function resolveLiveSessionModelSelection(params: {
    cfg?: {
        session?: {
            store?: string;
        };
    } | undefined;
    sessionKey?: string;
    agentId?: string;
    defaultProvider: string;
    defaultModel: string;
}): LiveSessionModelSelection | null;
export declare function requestLiveSessionModelSwitch(params: {
    sessionEntry?: Pick<SessionEntry, "sessionId">;
    selection: LiveSessionModelSelection;
}): boolean;
export declare function consumeLiveSessionModelSwitch(sessionId: string): LiveSessionModelSelection | undefined;
export declare function hasDifferentLiveSessionModelSelection(current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
}, next: LiveSessionModelSelection | null | undefined): next is LiveSessionModelSelection;
export declare function shouldTrackPersistedLiveSessionModelSelection(current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
}, persisted: LiveSessionModelSelection | null | undefined): boolean;
/**
 * Check whether a user-initiated live model switch is pending for the given
 * session.  Returns the persisted model selection when the session's
 * `liveModelSwitchPending` flag is `true` AND the persisted selection differs
 * from the currently running model; otherwise returns `undefined`.
 *
 * When the flag is set but the current model already matches the persisted
 * selection (e.g. the switch was applied as an override and the current
 * attempt is already using the new model), the flag is consumed (cleared)
 * eagerly to prevent it from persisting as stale state.
 *
 * **Deferral semantics:** The caller in `run.ts` only acts on the returned
 * selection when `canRestartForLiveSwitch` is `true`.  If the run cannot
 * restart (e.g. a tool call is in progress), the flag intentionally remains
 * set so the switch fires on the next clean retry opportunity — even if that
 * falls into a subsequent user turn.
 *
 * This replaces the previous approach that used an in-memory map
 * (`consumeEmbeddedRunModelSwitch`) which could not distinguish between
 * user-initiated `/model` switches and system-initiated fallback rotations.
 */
export declare function shouldSwitchToLiveModel(params: {
    cfg?: {
        session?: {
            store?: string;
        };
    } | undefined;
    sessionKey?: string;
    agentId?: string;
    defaultProvider: string;
    defaultModel: string;
    currentProvider: string;
    currentModel: string;
    currentAuthProfileId?: string;
    currentAuthProfileIdSource?: string;
}): LiveSessionModelSelection | undefined;
/**
 * Clear the `liveModelSwitchPending` flag from the session entry on disk so
 * subsequent retry iterations do not re-trigger the switch.
 */
export declare function clearLiveModelSwitchPending(params: {
    cfg?: {
        session?: {
            store?: string;
        };
    } | undefined;
    sessionKey?: string;
    agentId?: string;
}): Promise<void>;
