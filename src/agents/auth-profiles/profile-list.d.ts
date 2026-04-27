import type { AuthProfileStore } from "./types.js";
export declare function dedupeProfileIds(profileIds: string[]): string[];
export declare function listProfilesForProvider(store: AuthProfileStore, provider: string): string[];
