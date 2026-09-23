import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shortenHomePath } from "../../utils.js";
import {
  couldResolveProviderIdForAuth,
  hasUnresolvedProviderAuthEndpoint,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import { coerceLegacyFlatCredential } from "./legacy-flat-credential.js";
import {
  listLegacyAuthProfileSources,
  resolveLegacyAuthProfileSourceCandidates,
  type LegacyAuthProfileSource,
  type LegacyAuthProfileSourceKind,
} from "./legacy-source-files.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { parseLegacyCredentialEntry } from "./persisted.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  inspectPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import { AUTH_PROFILE_MIGRATION_COMMAND } from "./store-unreadable-error.js";

export { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
export {
  listLegacyAuthProfileArchives,
  listLegacyAuthProfileSources,
  resolveLegacyOAuthPath,
} from "./legacy-source-files.js";

const AUTH_PROFILE_MIGRATION_REQUIRED_CODE = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
const log = createSubsystemLogger("auth-profiles/persistence");

function isCredentialSource(source: LegacyAuthProfileSource): boolean {
  return source.kind !== "auth-state";
}

/** Read provider metadata only; unknown shapes retain the owner-wide refusal. */
export function readLegacyAuthProfileProviders(
  sources: readonly LegacyAuthProfileSource[],
): string[] | null {
  const providers = new Set<string>();
  for (const source of sources.filter(isCredentialSource)) {
    if (source.kind !== "auth-profiles") {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(source.path, "utf8"));
      if (!isRecord(raw)) {
        return null;
      }
      const nested = Object.hasOwn(raw, "profiles");
      const profiles = nested ? raw.profiles : raw;
      if (!isRecord(profiles) || Object.keys(profiles).length === 0) {
        return null;
      }
      for (const [key, profile] of Object.entries(profiles)) {
        const credential = nested
          ? parseLegacyCredentialEntry(profile)
          : coerceLegacyFlatCredential(key, profile);
        if (!credential) {
          return null;
        }
        const provider = credential.provider;
        // Keep untrusted metadata bounded and safe to include in diagnostics.
        if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(provider)) {
          return null;
        }
        providers.add(provider.toLowerCase());
        // Doctor migrates this retired provider id to the current OpenAI route.
        if (provider.toLowerCase() === "openai-codex") {
          providers.add("openai");
        }
      }
    } catch {
      return null;
    }
  }
  return providers.size > 0 ? [...providers].toSorted() : null;
}

function resolveAuthProfileOwnerPath(agentDir?: string, env?: NodeJS.ProcessEnv): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath(env);
}

export function hasLegacyAuthProfileCredentialSource(agentDir?: string): boolean {
  return listLegacyAuthProfileSources({ agentDir }).some(isCredentialSource);
}

/**
 * True when the canonical SQLite store already holds credentials for this owner.
 * A retired JSON file sitting next to a populated store is leftover bytes Doctor
 * has not archived yet, not unmigrated credentials: failing runtime closed there
 * would strand a working store over a file nothing reads.
 */
function hasMigratedAuthProfileCredentials(agentDir?: string, env?: NodeJS.ProcessEnv): boolean {
  let inspection: ReturnType<typeof inspectPersistedAuthProfileStoreRaw>;
  try {
    inspection =
      !agentDir && env
        ? inspectPersistedSharedAuthProfileStoreRaw(env)
        : inspectPersistedAuthProfileStoreRaw(agentDir);
  } catch {
    // An unreadable store is handled by its own canonical error; treat it as
    // "cannot serve credentials" so the legacy source stays fail-closed.
    return false;
  }
  if (inspection.status !== "readable") {
    return false;
  }
  const profiles = isRecord(inspection.raw) ? inspection.raw.profiles : undefined;
  return isRecord(profiles) && Object.keys(profiles).length > 0;
}

function listStartupLegacyAuthProfileSources(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Array<{
  agentDir: string;
  sources: LegacyAuthProfileSource[];
  /** Credential files that are not yet represented by the canonical store. */
  unmigratedCredentialSources: LegacyAuthProfileSource[];
}> {
  const sharedMainDir = resolveSharedMainAuthAgentDir(params.env);
  return [...new Set([...params.agentDirs, sharedMainDir])].map((agentDir) => {
    const sources = listLegacyAuthProfileSources({ agentDir, env: params.env });
    const credentialSources = sources.filter(isCredentialSource);
    return {
      agentDir,
      sources,
      unmigratedCredentialSources:
        credentialSources.length > 0 && hasMigratedAuthProfileCredentials(agentDir)
          ? []
          : credentialSources,
    };
  });
}

export function hasLegacyAuthProfileSourcesForStartup(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  let detected = false;
  for (const {
    agentDir,
    sources,
    unmigratedCredentialSources,
  } of listStartupLegacyAuthProfileSources(params)) {
    detected ||= sources.length > 0;
    if (unmigratedCredentialSources.length > 0) {
      markAuthProfileMigrationRequired(
        agentDir,
        new AuthProfileMigrationRequiredError({ agentDir, sources: unmigratedCredentialSources }),
      );
    }
  }
  return detected;
}

export class AuthProfileMigrationRequiredError extends Error {
  readonly code = AUTH_PROFILE_MIGRATION_REQUIRED_CODE;
  readonly action = AUTH_PROFILE_MIGRATION_COMMAND;
  readonly ownerId: string;
  readonly sourceKinds: LegacyAuthProfileSourceKind[];
  readonly affectedProviders: string[] | null;

  constructor(
    params:
      | {
          databasePath?: string;
          agentDir?: string;
          env?: NodeJS.ProcessEnv;
          sources: readonly LegacyAuthProfileSource[];
        }
      | AuthProfileMigrationRequiredError,
    previous?: AuthProfileMigrationRequiredError,
  ) {
    const ownerId =
      params instanceof AuthProfileMigrationRequiredError
        ? params.ownerId
        : shortenHomePath(
            params.databasePath ?? resolveAuthProfileOwnerPath(params.agentDir, params.env),
          );
    const sourceKinds = [
      ...new Set([
        ...(previous?.sourceKinds ?? []),
        ...(params instanceof AuthProfileMigrationRequiredError
          ? params.sourceKinds
          : params.sources.map((source) => source.kind)),
      ]),
    ].toSorted();
    const providers =
      params instanceof AuthProfileMigrationRequiredError
        ? params.affectedProviders
        : readLegacyAuthProfileProviders(params.sources);
    const affectedProviders =
      providers && previous?.affectedProviders !== null
        ? [...new Set([...(previous?.affectedProviders ?? []), ...providers])].toSorted()
        : null;
    super(
      `Auth profile store ${ownerId} requires legacy credential migration; affected providers: ${affectedProviders?.join(", ") ?? "all (legacy provider scope unavailable)"}; run ${AUTH_PROFILE_MIGRATION_COMMAND}.`,
    );
    this.name = "AuthProfileMigrationRequiredError";
    this.ownerId = ownerId;
    this.sourceKinds = sourceKinds;
    this.affectedProviders = affectedProviders;
  }

  blocksProvider(provider?: string, config?: OpenClawConfig): boolean {
    if (!provider || !this.affectedProviders) {
      return true;
    }
    if (hasUnresolvedProviderAuthEndpoint(provider, { config })) {
      return true;
    }
    const requested = resolveProviderIdForAuth(provider, {
      config,
      storedCredential: config === undefined,
    });
    return this.affectedProviders.some(
      (affected) =>
        resolveProviderIdForAuth(affected, { config, storedCredential: true }) === requested,
    );
  }
}

const migrationRequiredByDatabase = new Map<string, AuthProfileMigrationRequiredError>();
const warnedLegacySourceDatabases = new Set<string>();

export function warnLegacyAuthProfileSourcesIgnored(params: {
  databasePath?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  sources: readonly LegacyAuthProfileSource[];
}): void {
  if (params.sources.length === 0) {
    return;
  }
  const databasePath =
    params.databasePath ?? resolveAuthProfileOwnerPath(params.agentDir, params.env);
  if (warnedLegacySourceDatabases.has(databasePath)) {
    return;
  }
  warnedLegacySourceDatabases.add(databasePath);
  log.warn("retired auth profile files are ignored by runtime; run Doctor to archive them", {
    code: AUTH_PROFILE_MIGRATION_REQUIRED_CODE,
    ownerId: shortenHomePath(databasePath),
    sourceKinds: [...new Set(params.sources.map((source) => source.kind))].toSorted(),
    action: AUTH_PROFILE_MIGRATION_COMMAND,
  });
}

function recordAuthProfileMigrationRequired(
  databasePath: string,
  error: AuthProfileMigrationRequiredError,
): AuthProfileMigrationRequiredError {
  const previous = migrationRequiredByDatabase.get(databasePath);
  // Scoped reads may discover more providers, but only lifecycle clear may release any.
  const retained = previous ? new AuthProfileMigrationRequiredError(error, previous) : error;
  migrationRequiredByDatabase.set(databasePath, retained);
  if (previous?.message !== retained.message) {
    log.warn(retained.message, {
      code: retained.code,
      affectedProviders: retained.affectedProviders,
      action: retained.action,
    });
  }
  return retained;
}

export function markAuthProfileMigrationRequired(
  agentDir: string | undefined,
  error: AuthProfileMigrationRequiredError,
  env?: NodeJS.ProcessEnv,
): void {
  const databasePath = resolveAuthProfileOwnerPath(agentDir, env);
  recordAuthProfileMigrationRequired(databasePath, error);
}

/** Publication must honor a recorded refusal without rediscovering an ambient owner. */
export function assertAuthProfileMigrationStateAtDatabasePath(
  databasePath: string,
  provider?: string,
  config?: OpenClawConfig,
  deferScopedRefusals = false,
): void {
  const error = migrationRequiredByDatabase.get(databasePath);
  if (
    error &&
    !(deferScopedRefusals && error.affectedProviders !== null) &&
    error.blocksProvider(provider, config)
  ) {
    // The activated secrets snapshot for this owner is empty. Only an explicit
    // lifecycle clear/reload may remove the error and publish migrated SQLite rows.
    throw error;
  }
}

/** A selected row cannot escape its own owner's fence by changing endpoint aliases. */
export function assertAuthProfileCredentialMigrationStateAtDatabasePath(
  databasePath: string,
  provider: string,
  config?: OpenClawConfig,
): void {
  const error = migrationRequiredByDatabase.get(databasePath);
  if (!error) {
    return;
  }
  const requested = resolveProviderIdForAuth(provider, { config });
  if (
    !error.affectedProviders ||
    hasUnresolvedProviderAuthEndpoint(provider, { config }) ||
    error.affectedProviders.some((affected) =>
      couldResolveProviderIdForAuth(affected, requested, { config }),
    )
  ) {
    throw error;
  }
}

export function assertAuthProfileMigrationCandidates(params: {
  databasePath: string;
  candidates: readonly LegacyAuthProfileSource[];
  hasCredentials: () => boolean;
  provider?: string;
  config?: OpenClawConfig;
  deferScopedRefusals?: boolean;
}): void {
  assertAuthProfileMigrationStateAtDatabasePath(
    params.databasePath,
    params.provider,
    params.config,
    params.deferScopedRefusals,
  );
  // Older shipped processes and restores can recreate these three fixed files
  // after startup, so this credential boundary deliberately rechecks their names.
  const sources = params.candidates.filter(
    (source) => isCredentialSource(source) && fs.existsSync(source.path),
  );
  if (sources.length === 0) {
    return;
  }
  // The store read only happens once a retired file actually exists, so the
  // healthy majority keeps the plain name check on this hot path.
  if (params.hasCredentials()) {
    warnLegacyAuthProfileSourcesIgnored({ databasePath: params.databasePath, sources });
    return;
  }
  const migrationError = recordAuthProfileMigrationRequired(
    params.databasePath,
    new AuthProfileMigrationRequiredError({ databasePath: params.databasePath, sources }),
  );
  if (
    !(params.deferScopedRefusals && migrationError.affectedProviders !== null) &&
    migrationError.blocksProvider(params.provider, params.config)
  ) {
    throw migrationError;
  }
}

export function assertAuthProfileMigrationReady(
  agentDir?: string,
  env?: NodeJS.ProcessEnv,
  provider?: string,
  config?: OpenClawConfig,
  deferScopedRefusals = false,
): void {
  assertAuthProfileMigrationCandidates({
    databasePath: resolveAuthProfileOwnerPath(agentDir, env),
    candidates: resolveLegacyAuthProfileSourceCandidates({ agentDir, env }),
    hasCredentials: () => hasMigratedAuthProfileCredentials(agentDir, env),
    provider,
    config,
    deferScopedRefusals,
  });
}

export function clearAuthProfileMigrationDiagnostics(): void {
  migrationRequiredByDatabase.clear();
  warnedLegacySourceDatabases.clear();
}
