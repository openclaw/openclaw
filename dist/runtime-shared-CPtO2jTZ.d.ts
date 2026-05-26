import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { p as SecretRef } from "./types.secrets-tbFW-hY6.js";

//#region src/secrets/resolve-types.d.ts
type SecretRefResolveCache = {
  resolvedByRefKey?: Map<string, Promise<unknown>>;
  filePayloadByProvider?: Map<string, Promise<unknown>>;
};
//#endregion
//#region src/secrets/runtime-shared.d.ts
type SecretResolverWarningCode = "SECRETS_REF_OVERRIDES_PLAINTEXT" | "SECRETS_REF_IGNORED_INACTIVE_SURFACE" | "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT" | "WEB_SEARCH_AUTODETECT_SELECTED" | "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED" | "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK" | "WEB_FETCH_PROVIDER_INVALID_AUTODETECT" | "WEB_FETCH_AUTODETECT_SELECTED" | "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED" | "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK";
type SecretResolverWarning = {
  code: SecretResolverWarningCode;
  path: string;
  message: string;
};
type SecretAssignment = {
  ref: SecretRef;
  path: string;
  expected: "string" | "string-or-object";
  apply: (value: unknown) => void;
};
type ResolverContext = {
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cache: SecretRefResolveCache;
  warnings: SecretResolverWarning[];
  warningKeys: Set<string>;
  assignments: SecretAssignment[];
};
type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
declare function createResolverContext(params: {
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ResolverContext;
declare function pushAssignment(context: ResolverContext, assignment: SecretAssignment): void;
declare function pushWarning(context: ResolverContext, warning: SecretResolverWarning): void;
declare function pushInactiveSurfaceWarning(params: {
  context: ResolverContext;
  path: string;
  details?: string;
}): void;
declare function collectSecretInputAssignment(params: {
  value: unknown;
  path: string;
  expected: SecretAssignment["expected"];
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
  apply: (value: unknown) => void;
}): void;
declare function applyResolvedAssignments(params: {
  assignments: SecretAssignment[];
  resolved: Map<string, unknown>;
}): void;
declare function hasOwnProperty(record: Record<string, unknown>, key: string): boolean;
declare function isEnabledFlag(value: unknown): boolean;
declare function isChannelAccountEffectivelyEnabled(channel: Record<string, unknown>, account: Record<string, unknown>): boolean;
//#endregion
export { SecretResolverWarningCode as a, createResolverContext as c, isEnabledFlag as d, pushAssignment as f, SecretRefResolveCache as h, SecretResolverWarning as i, hasOwnProperty as l, pushWarning as m, SecretAssignment as n, applyResolvedAssignments as o, pushInactiveSurfaceWarning as p, SecretDefaults as r, collectSecretInputAssignment as s, ResolverContext as t, isChannelAccountEffectivelyEnabled as u };