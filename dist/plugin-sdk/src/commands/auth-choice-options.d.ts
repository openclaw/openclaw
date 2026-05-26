import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AuthChoiceGroup, type AuthChoiceOption } from "./auth-choice-options.static.js";
export declare function formatAuthChoiceChoicesForCli(params?: {
    includeSkip?: boolean;
    includeLegacyAliases?: boolean;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function buildAuthChoiceOptions(params: {
    store: AuthProfileStore;
    includeSkip: boolean;
    assistantVisibleOnly?: boolean;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[];
export declare function buildAuthChoiceGroups(params: {
    store: AuthProfileStore;
    includeSkip: boolean;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): {
    groups: AuthChoiceGroup[];
    skipOption?: AuthChoiceOption;
};
