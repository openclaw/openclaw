import type { AuthProfileStore } from "./types.js";
/**
 * Sync OAuth credentials from external CLI tools (Qwen Code CLI, MiniMax CLI) into the store.
 *
 * Returns true if any credentials were updated.
 */
export declare function syncExternalCliCredentials(store: AuthProfileStore): boolean;
