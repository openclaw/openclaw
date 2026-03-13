import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { type ResolverContext } from "./runtime-shared.js";
export declare function collectAuthStoreAssignments(params: {
    store: AuthProfileStore;
    context: ResolverContext;
    agentDir: string;
}): void;
