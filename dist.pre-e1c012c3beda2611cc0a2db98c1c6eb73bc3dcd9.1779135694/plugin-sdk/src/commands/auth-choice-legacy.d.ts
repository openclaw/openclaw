import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthChoice } from "./onboard-types.js";
export declare function resolveLegacyAuthChoiceAliasesForCli(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ReadonlyArray<AuthChoice>;
export declare function normalizeLegacyOnboardAuthChoice(authChoice: AuthChoice | undefined, params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): AuthChoice | undefined;
export declare function isDeprecatedAuthChoice(authChoice: AuthChoice | undefined, params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): authChoice is AuthChoice;
export declare function resolveDeprecatedAuthChoiceReplacement(authChoice: AuthChoice, params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): {
    normalized: AuthChoice;
    message: string;
} | undefined;
export declare function formatDeprecatedNonInteractiveAuthChoiceError(authChoice: AuthChoice, params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): string | undefined;
