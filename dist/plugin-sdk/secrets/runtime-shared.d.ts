import type { OpenClawConfig } from "../config/config.js";
import { type SecretRef } from "../config/types.secrets.js";
import type { SecretRefResolveCache } from "./resolve.js";
export type SecretResolverWarningCode = "SECRETS_REF_OVERRIDES_PLAINTEXT" | "SECRETS_REF_IGNORED_INACTIVE_SURFACE";
export type SecretResolverWarning = {
    code: SecretResolverWarningCode;
    path: string;
    message: string;
};
export type SecretAssignment = {
    ref: SecretRef;
    path: string;
    expected: "string" | "string-or-object";
    apply: (value: unknown) => void;
};
export type ResolverContext = {
    sourceConfig: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    cache: SecretRefResolveCache;
    warnings: SecretResolverWarning[];
    warningKeys: Set<string>;
    assignments: SecretAssignment[];
};
export type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
export declare function createResolverContext(params: {
    sourceConfig: OpenClawConfig;
    env: NodeJS.ProcessEnv;
}): ResolverContext;
export declare function pushAssignment(context: ResolverContext, assignment: SecretAssignment): void;
export declare function pushWarning(context: ResolverContext, warning: SecretResolverWarning): void;
export declare function pushInactiveSurfaceWarning(params: {
    context: ResolverContext;
    path: string;
    details?: string;
}): void;
export declare function collectSecretInputAssignment(params: {
    value: unknown;
    path: string;
    expected: SecretAssignment["expected"];
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    active?: boolean;
    inactiveReason?: string;
    apply: (value: unknown) => void;
}): void;
export declare function applyResolvedAssignments(params: {
    assignments: SecretAssignment[];
    resolved: Map<string, unknown>;
}): void;
export declare function hasOwnProperty(record: Record<string, unknown>, key: string): boolean;
export declare function isEnabledFlag(value: unknown): boolean;
export declare function isChannelAccountEffectivelyEnabled(channel: Record<string, unknown>, account: Record<string, unknown>): boolean;
