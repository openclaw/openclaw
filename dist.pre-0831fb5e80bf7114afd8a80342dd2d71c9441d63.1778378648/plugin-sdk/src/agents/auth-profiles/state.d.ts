import type { AuthProfileState, AuthProfileStateStore } from "./types.js";
export declare function coerceAuthProfileState(raw: unknown): AuthProfileState;
export declare function mergeAuthProfileState(base: AuthProfileState, override: AuthProfileState): AuthProfileState;
export declare function loadPersistedAuthProfileState(agentDir?: string): AuthProfileState;
export declare function savePersistedAuthProfileState(store: AuthProfileState, agentDir?: string): AuthProfileStateStore | null;
