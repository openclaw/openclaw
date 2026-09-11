import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  getConfigProviderUseBindings,
  resolveConfigProviderUseBindings,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderBindingEnvVarCandidates } from "../secrets/provider-env-vars.js";
import { isSetupCredentialAccessible } from "./auth-profiles/setup-access.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";

export type ProviderUseBinding =
  | { kind: "provider-config" }
  | { kind: "profile"; profileId: string }
  | { kind: "native-account" }
  | { kind: "environment"; envVar: string };

const GENERIC_CREDENTIAL_ENV_VARS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "MODEL_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

export function isGenericProviderCredentialEnvVar(name: string): boolean {
  return GENERIC_CREDENTIAL_ENV_VARS.has(name);
}

/** Preserve manifest-owned variable provenance while inheriting provider credential aliases. */
export function resolveProviderUseBindingCredentialPolicy(
  providerEnvVars: ProviderBindingEnvVarCandidates,
  aliasMap: Readonly<Record<string, string>>,
) {
  const envCandidateMap: Record<string, readonly string[]> = Object.fromEntries(
    Object.entries(providerEnvVars).map(([provider, declarations]) => [
      provider,
      declarations.flatMap((declaration) => declaration.envVars),
    ]),
  );
  const manifestVariables = new Set(Object.values(envCandidateMap).flat());
  for (const [alias, provider] of Object.entries(aliasMap)) {
    envCandidateMap[alias] ??= envCandidateMap[provider] ?? [];
  }
  return { aliasMap, envCandidateMap, manifestVariables };
}

/** Startup and Doctor share the same conservative saved-account family boundary. */
export function providerUseBindingConflictsWithAccount(
  providerId: string,
  storedProviderId: string,
  policy: ReturnType<typeof resolveProviderUseBindingCredentialPolicy>,
): boolean {
  const provider = normalizeProviderId(providerId);
  const storedProvider = normalizeProviderId(storedProviderId);
  const { aliasMap, envCandidateMap, manifestVariables } = policy;
  return (
    storedProvider === provider ||
    [provider, storedProvider].every(
      (id) => id === "amazon-bedrock" || id === "amazon-bedrock-mantle",
    ) ||
    (aliasMap[storedProvider] ?? storedProvider) === (aliasMap[provider] ?? provider) ||
    (envCandidateMap[storedProvider] ?? []).some(
      (name) => manifestVariables.has(name) && (envCandidateMap[provider] ?? []).includes(name),
    )
  );
}

export function findStartupProviderUseBindingConflict(params: {
  provider: string;
  config?: OpenClawConfig;
  profiles: Iterable<readonly [string, Pick<AuthProfileCredential, "provider">]>;
  providerEnvVars: ProviderBindingEnvVarCandidates;
  providerAuthAliases: Readonly<Record<string, string>>;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const binding = getConfigProviderUseBindings(params.config)[provider];
  if (!binding) {
    return undefined;
  }
  const policy = resolveProviderUseBindingCredentialPolicy(
    params.providerEnvVars,
    params.providerAuthAliases,
  );
  for (const [profileId, profile] of params.profiles) {
    if (providerUseBindingConflictsWithAccount(provider, profile.provider, policy)) {
      return profileId;
    }
  }
  return undefined;
}

/** One declaring chat plugin may bind its own family, but never a competing plugin. */
export function resolveProviderEnvironmentAdmission(params: {
  env?: NodeJS.ProcessEnv;
  providerEnvVars?: ProviderBindingEnvVarCandidates;
}): {
  bindings: ReadonlyMap<string, { kind: "environment"; envVar: string }>;
  conflicts: readonly {
    envVar: string;
    pluginIds: readonly string[];
    providers: readonly string[];
  }[];
} {
  const env = params.env ?? process.env;
  const owners = new Map<string, Map<string, Set<string>>>();
  for (const [provider, declarations] of Object.entries(params.providerEnvVars ?? {})) {
    for (const declaration of declarations) {
      for (const envVar of declaration.envVars) {
        if (isGenericProviderCredentialEnvVar(envVar) || !env[envVar]?.trim()) {
          continue;
        }
        const plugins = owners.get(envVar) ?? new Map<string, Set<string>>();
        const pluginId = declaration.pluginId.trim().toLowerCase();
        const providers = plugins.get(pluginId) ?? new Set<string>();
        providers.add(normalizeProviderId(provider));
        plugins.set(pluginId, providers);
        owners.set(envVar, plugins);
      }
    }
  }
  const bindings = new Map<string, { kind: "environment"; envVar: string }>();
  const conflicts: Array<{ envVar: string; pluginIds: string[]; providers: string[] }> = [];
  for (const [envVar, plugins] of owners) {
    const providerIds = new Set<string>();
    for (const ids of plugins.values()) {
      for (const id of ids) {
        providerIds.add(id);
      }
    }
    if (plugins.size !== 1) {
      conflicts.push({ envVar, pluginIds: [...plugins.keys()], providers: [...providerIds] });
    }
  }
  // Each provider's manifest order chooses its credential, not a sibling's declaration order.
  for (const [provider, declarations] of Object.entries(params.providerEnvVars ?? {})) {
    const id = normalizeProviderId(provider);
    for (const declaration of declarations) {
      for (const envVar of declaration.envVars) {
        if (owners.get(envVar)?.size === 1 && !bindings.has(id)) {
          bindings.set(id, { kind: "environment", envVar });
        }
      }
    }
  }
  return { bindings, conflicts };
}

/** Provider intent is independent of credential readiness and catalog visibility. */
export function resolveProviderUseAdmission(params: {
  config?: OpenClawConfig;
  /** Persistence planning must distinguish runtime upgrade facts from authored entries. */
  includeRuntimeBindings?: boolean;
  env?: NodeJS.ProcessEnv;
  providerEnvVars?: ProviderBindingEnvVarCandidates;
  profiles?: Readonly<Record<string, Pick<AuthProfileCredential, "provider" | "setup">>>;
  nativeProviders?: Iterable<string>;
  /** Selected routes may retain accounts through unconditional credential-family aliases. */
  requestedProviders?: Iterable<string>;
  storedCredentialAuthAliases?: Readonly<Record<string, string>>;
}): ReadonlyMap<string, ProviderUseBinding> {
  const config =
    params.config && params.includeRuntimeBindings !== false
      ? resolveConfigProviderUseBindings(params.config)
      : params.config;
  const admitted = new Map<string, ProviderUseBinding>();
  const add = (provider: string, binding: ProviderUseBinding) => {
    const id = normalizeProviderId(provider);
    if (id && !admitted.has(id)) {
      admitted.set(id, binding);
    }
  };
  for (const provider of Object.keys(config?.models?.providers ?? {})) {
    add(provider, { kind: "provider-config" });
  }
  for (const [profileId, profile] of Object.entries(params.profiles ?? {})) {
    if (!isSetupCredentialAccessible({ profileId, credential: profile })) {
      continue;
    }
    add(profile.provider, { kind: "profile", profileId });
  }
  for (const provider of params.requestedProviders ?? []) {
    if (admitted.has(normalizeProviderId(provider))) {
      continue;
    }
    const normalized = normalizeProviderId(provider);
    const credentialProvider = params.storedCredentialAuthAliases?.[normalized] ?? normalized;
    for (const [profileId, profile] of Object.entries(params.profiles ?? {})) {
      if (
        isSetupCredentialAccessible({ profileId, credential: profile }) &&
        (params.storedCredentialAuthAliases?.[normalizeProviderId(profile.provider)] ??
          normalizeProviderId(profile.provider)) === credentialProvider
      ) {
        add(provider, { kind: "profile", profileId });
        break;
      }
    }
  }
  for (const provider of params.nativeProviders ?? []) {
    add(provider, { kind: "native-account" });
  }
  for (const [provider, binding] of resolveProviderEnvironmentAdmission(params).bindings) {
    add(provider, binding);
  }
  return admitted;
}

type ProviderModelAuthReadiness = "ready" | "unknown" | "unavailable";

export type ProviderModelAuthEvidence =
  | "aws-sdk"
  | "environment"
  | "none"
  | "profile"
  | "provider-config"
  | "runtime"
  | "synthetic";

export type ProviderModelAuthProfileSource = {
  kind: "profile";
  profileId: string;
  provider?: string;
  mode?: string;
  readiness: ProviderModelAuthReadiness;
  cooldown: "active" | "clear";
};

/**
 * Whether config authorizes this credential, as opposed to where it was found.
 *
 * `evidence` is provenance and is reported as such by status/probe surfaces; it
 * cannot carry authorization, because a *declared* credential can legitimately
 * be discovered in the environment (a `${VAR}` marker or a SecretRef naming a
 * canonical variable). `"ambient"` means the opposite: the credential appears in
 * neither the provider entry nor `auth.profiles`/`auth.order`, so nothing in
 * config points at it and it may bill an account the operator never named here.
 */
export type ProviderModelAuthAuthorization = "declared" | "ambient";

export type ProviderModelAuthDirectSource = {
  kind: "direct";
  mode?: string;
  readiness: ProviderModelAuthReadiness;
  evidence: ProviderModelAuthEvidence;
  authorization: ProviderModelAuthAuthorization;
  /** Independently admitted environment source; does not inherit a profile's authority. */
  boundEnvVar?: string;
};

export type ProviderModelAuthSource =
  | ProviderModelAuthProfileSource
  | ProviderModelAuthDirectSource;

/** Secret-free credential-source fact safe to carry across request boundaries. */
export type ProviderModelAuthSourceClassification =
  | { kind: "profile" }
  | {
      kind: "direct";
      evidence: ProviderModelAuthEvidence;
      authorization: ProviderModelAuthAuthorization;
    };

/** Drops profile ids, modes, readiness, and cooldown state from a selected source. */
export function classifyProviderModelAuthSource(
  source: ProviderModelAuthSource,
): ProviderModelAuthSourceClassification {
  return source.kind === "profile"
    ? { kind: "profile" }
    : {
        kind: "direct",
        evidence: source.evidence,
        authorization: source.authorization,
      };
}

type ProviderModelAuthRequiredReason = "configured-auth" | "provider-binding" | "runtime-binding";

type ProviderModelAuthAutomaticProfiles =
  | { kind: "empty"; explicitOrder: boolean }
  | {
      kind: "usable";
      explicitOrder: boolean;
      profiles: readonly ProviderModelAuthProfileSource[];
    }
  | {
      kind: "all-unavailable";
      explicitOrder: boolean;
      first: ProviderModelAuthProfileSource;
    }
  | {
      kind: "all-cooldown";
      explicitOrder: boolean;
      first: ProviderModelAuthProfileSource;
    };

export type ProviderModelAuthSourcePlan =
  | {
      kind: "required";
      reason: ProviderModelAuthRequiredReason;
      source: ProviderModelAuthSource;
    }
  | {
      kind: "automatic";
      profiles: ProviderModelAuthAutomaticProfiles;
      orderedProfiles: readonly ProviderModelAuthProfileSource[];
      allowCooldown: boolean;
      fallback?: ProviderModelAuthDirectSource;
      /**
       * How many profiles the operator declared for this provider, before any
       * readiness, cooldown or route-compatibility filtering. Route filtering
       * rebuilds the plan from a narrowed profile list, so `profiles.kind` alone
       * cannot distinguish "operator declared nothing" (zero-config) from
       * "everything the operator declared was filtered out".
       */
      declaredProfileCount: number;
    };

export function toProviderModelAuthReadiness(
  availability: boolean | undefined,
): ProviderModelAuthReadiness {
  return availability === true ? "ready" : availability === false ? "unavailable" : "unknown";
}

export function fromProviderModelAuthReadiness(
  readiness: ProviderModelAuthReadiness,
): boolean | undefined {
  return readiness === "ready" ? true : readiness === "unavailable" ? false : undefined;
}

/** Creates a source fact without retaining credential material. */
export function buildProviderModelAuthDirectSource(params: {
  mode?: string;
  availability?: boolean;
  evidence: ProviderModelAuthEvidence;
  /**
   * Required, not defaulted: a permissive default would silently give every
   * unaudited construction site full standing, which is exactly how a source
   * escapes the ambient-credential rule. Make each caller state it.
   */
  authorization: ProviderModelAuthAuthorization;
  boundEnvVar?: string;
}): ProviderModelAuthDirectSource {
  return {
    kind: "direct",
    mode: params.mode,
    readiness: toProviderModelAuthReadiness(params.availability),
    evidence: params.evidence,
    authorization: params.authorization,
    ...(params.boundEnvVar ? { boundEnvVar: params.boundEnvVar } : {}),
  };
}

function reorderPreferredProfile(
  profiles: readonly ProviderModelAuthProfileSource[],
  preferredProfileId: string | undefined,
): ProviderModelAuthProfileSource[] {
  if (!preferredProfileId) {
    return [...profiles];
  }
  const preferred = profiles.find((profile) => profile.profileId === preferredProfileId);
  return preferred
    ? [preferred, ...profiles.filter((profile) => profile.profileId !== preferredProfileId)]
    : [...profiles];
}

/** Applies source precedence and automatic-tier readiness/cooldown policy once. */
export function buildProviderModelAuthSourcePlan(params: {
  ownership?: {
    reason: ProviderModelAuthRequiredReason;
    source: ProviderModelAuthSource;
  };
  profiles: readonly ProviderModelAuthProfileSource[];
  preferredProfileId?: string;
  explicitOrder?: boolean;
  fallback?: ProviderModelAuthDirectSource;
  allowCooldown?: boolean;
  /** Overrides the declared count when rebuilding a plan from filtered profiles. */
  declaredProfileCount?: number;
}): ProviderModelAuthSourcePlan {
  if (params.ownership) {
    return { kind: "required", ...params.ownership };
  }
  const explicitOrder = params.explicitOrder === true;
  const ordered = reorderPreferredProfile(params.profiles, params.preferredProfileId);
  let profiles: ProviderModelAuthAutomaticProfiles;
  if (ordered.length === 0) {
    profiles = { kind: "empty", explicitOrder };
  } else {
    const available = ordered.filter((profile) => profile.readiness !== "unavailable");
    if (available.length === 0) {
      const [firstOrdered] = ordered;
      profiles = firstOrdered
        ? { kind: "all-unavailable", explicitOrder, first: firstOrdered }
        : { kind: "empty", explicitOrder };
    } else {
      const outsideCooldown = available.filter((profile) => profile.cooldown === "clear");
      if (outsideCooldown.length > 0) {
        profiles = { kind: "usable", explicitOrder, profiles: outsideCooldown };
      } else if (params.allowCooldown) {
        profiles = { kind: "usable", explicitOrder, profiles: available.slice(0, 1) };
      } else {
        const [firstAvailable] = available;
        profiles = firstAvailable
          ? { kind: "all-cooldown", explicitOrder, first: firstAvailable }
          : { kind: "empty", explicitOrder };
      }
    }
  }
  return {
    kind: "automatic",
    profiles,
    orderedProfiles: ordered,
    allowCooldown: params.allowCooldown === true,
    declaredProfileCount: params.declaredProfileCount ?? ordered.length,
    ...(params.fallback ? { fallback: params.fallback } : {}),
  };
}
