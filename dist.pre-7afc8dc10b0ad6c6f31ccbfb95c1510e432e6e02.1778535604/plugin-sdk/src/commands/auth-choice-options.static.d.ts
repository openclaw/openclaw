import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";
export type AuthChoiceOption = {
    value: AuthChoice;
    label: string;
    hint?: string;
    groupId?: AuthChoiceGroupId;
    groupLabel?: string;
    groupHint?: string;
    assistantPriority?: number;
    assistantVisibility?: "visible" | "manual-only";
};
export type AuthChoiceGroup = {
    value: AuthChoiceGroupId;
    label: string;
    hint?: string;
    options: AuthChoiceOption[];
};
export declare const CORE_AUTH_CHOICE_OPTIONS: ReadonlyArray<AuthChoiceOption>;
export declare function formatStaticAuthChoiceChoicesForCli(params?: {
    includeSkip?: boolean;
    includeLegacyAliases?: boolean;
    config?: import("../config/config.js").OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): string;
