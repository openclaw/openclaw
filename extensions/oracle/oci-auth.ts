import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigFileReader, Realm, Region, SimpleAuthenticationDetailsProvider } from "oci-common";
import { ensureAuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/agent-runtime";
import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  normalizeOptionalSecretInput,
  upsertAuthProfile,
} from "openclaw/plugin-sdk/provider-auth-api-key";

type OracleStoredProfile = {
  profileId: string;
  configFile: string;
  metadata: Record<string, string>;
};

export type OracleResolvedAuth = {
  configFile: string;
  profile: string;
  compartmentId: string;
  tenancyId: string;
};

type ResolveOracleAuthParams = {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
  profile?: string;
  compartmentId?: string;
  profileId?: string;
  allowStoredProfileFallback?: boolean;
};

const DEFAULT_PROFILE_NAME = "DEFAULT";

export const ORACLE_PROVIDER_ID = "oracle";
export const ORACLE_PROFILE_ID = "oracle:default";
export const ORACLE_MISSING_CONFIG_FILE_ERROR =
  "Oracle OCI auth requires an OCI config file. Set OCI_CONFIG_FILE or configure the Oracle provider.";
export const ORACLE_ENV_VARS = [
  "OCI_CONFIG_FILE",
  "OCI_PROFILE",
  "OCI_CLI_PROFILE",
  "OCI_COMPARTMENT_ID",
] as const;

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOracleDefaultConfigFile(): string {
  return path.join(os.homedir(), ".oci", "config");
}

function resolveOracleEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ?? process.env;
}

function ensureReadableFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`OCI config file not found: ${resolved}`);
  }
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) {
    throw new Error(`OCI config path is not a file: ${resolved}`);
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    throw new Error(`OCI config file is not readable: ${resolved}`);
  }
  return resolved;
}

function readOracleReferencedFile(filePath: string, label: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`OCI ${label} file is not readable: ${filePath}`);
  }
}

function resolveOracleConfigReferencePath(configFile: string, configuredPath: string): string {
  const expanded = ConfigFileReader.expandUserHome(configuredPath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(path.dirname(configFile), expanded);
}

function requireOracleConfigValue(value: string | null, key: string, configFile: string): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    throw new Error(`OCI profile is missing ${key} in ${configFile}`);
  }
  return trimmed;
}

function resolveOracleRegion(regionId: string): Region {
  let region = Region.fromRegionId(regionId);
  if (region) {
    return region;
  }

  const fallbackSecondLevelDomain = trimToUndefined(process.env.OCI_DEFAULT_REALM);
  if (fallbackSecondLevelDomain) {
    const unknownRealm = Realm.register("unknown", fallbackSecondLevelDomain);
    region = Region.register(regionId, unknownRealm);
    return region;
  }

  return Region.register(regionId, Realm.OC1);
}

export function createOracleAuthenticationDetailsProvider(params: {
  configFile: string;
  profile?: string;
}): SimpleAuthenticationDetailsProvider {
  const resolvedConfigFile = ensureReadableFile(params.configFile);
  const resolvedProfile = trimToUndefined(params.profile) ?? DEFAULT_PROFILE_NAME;
  const config = ConfigFileReader.parseFileFromPath(resolvedConfigFile, resolvedProfile);

  const authType = trimToUndefined(config.get("authentication_type"));
  const tenancyId = requireOracleConfigValue(config.get("tenancy"), "tenancy", resolvedConfigFile);
  const regionId = trimToUndefined(config.get("region")) ?? trimToUndefined(process.env.OCI_REGION);
  if (!regionId) {
    throw new Error(
      `OCI profile "${resolvedProfile}" is missing region in ${resolvedConfigFile} and OCI_REGION is not set`,
    );
  }
  const region = resolveOracleRegion(regionId);
  const delegationTokenPath = trimToUndefined(config.get("delegation_token_file"));
  const delegationToken = delegationTokenPath
    ? readOracleReferencedFile(
        resolveOracleConfigReferencePath(resolvedConfigFile, delegationTokenPath),
        "delegation token",
      ).replace(/\n/g, "")
    : "";

  if (authType) {
    return new SimpleAuthenticationDetailsProvider(
      tenancyId,
      "",
      "",
      "",
      "",
      region,
      authType,
      delegationToken,
    );
  }

  const fingerprint = requireOracleConfigValue(
    config.get("fingerprint"),
    "fingerprint",
    resolvedConfigFile,
  );
  const keyFile = requireOracleConfigValue(config.get("key_file"), "key_file", resolvedConfigFile);
  const privateKey = readOracleReferencedFile(
    resolveOracleConfigReferencePath(resolvedConfigFile, keyFile),
    "private key",
  );
  const passPhrase = config.get("pass_phrase");
  const sessionTokenPath = trimToUndefined(config.get("security_token_file"));
  const sessionToken = sessionTokenPath
    ? readOracleReferencedFile(
        resolveOracleConfigReferencePath(resolvedConfigFile, sessionTokenPath),
        "security token",
      )
    : undefined;
  const user = sessionToken
    ? ""
    : requireOracleConfigValue(config.get("user"), "user", resolvedConfigFile);

  return new SimpleAuthenticationDetailsProvider(
    tenancyId,
    user,
    fingerprint,
    privateKey,
    passPhrase,
    region,
    undefined,
    undefined,
    config.profileCredentials,
    sessionToken,
  );
}

function loadStoredOracleProfile(
  agentDir?: string,
  requestedProfileId?: string,
): OracleStoredProfile | null {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const candidateIds = requestedProfileId
    ? [requestedProfileId]
    : listProfilesForProvider(store, ORACLE_PROVIDER_ID);

  for (const profileId of candidateIds) {
    const profile = store.profiles[profileId];
    if (!profile || profile.type !== "api_key") {
      continue;
    }
    const configFile = trimToUndefined(profile.key);
    if (!configFile) {
      continue;
    }
    return {
      profileId,
      configFile,
      metadata: profile.metadata ?? {},
    };
  }

  return null;
}

function validateOracleConfigFileInternal(
  configFile: string,
  profile?: string,
): OracleResolvedAuth {
  const resolvedConfigFile = ensureReadableFile(configFile);
  const resolvedProfile = trimToUndefined(profile) ?? DEFAULT_PROFILE_NAME;
  const authProvider = createOracleAuthenticationDetailsProvider({
    configFile: resolvedConfigFile,
    profile: resolvedProfile,
  });
  const tenancyId = trimToUndefined(authProvider.getTenantId());
  if (!tenancyId) {
    throw new Error(`OCI profile "${resolvedProfile}" is missing tenancy in ${resolvedConfigFile}`);
  }

  return {
    configFile: resolvedConfigFile,
    profile: resolvedProfile,
    compartmentId: tenancyId,
    tenancyId,
  };
}

export function validateOracleConfigFile(configFile: string, profile?: string): OracleResolvedAuth {
  return validateOracleConfigFileInternal(configFile, profile);
}

export function resolveOracleAuth(params: ResolveOracleAuthParams): OracleResolvedAuth {
  const env = resolveOracleEnv(params.env);
  const stored =
    params.allowStoredProfileFallback === false ||
    (params.agentDir === undefined && params.profileId === undefined)
      ? null
      : loadStoredOracleProfile(params.agentDir, params.profileId);
  const configFile =
    trimToUndefined(params.configFile) ??
    trimToUndefined(env.OCI_CONFIG_FILE) ??
    stored?.configFile ??
    (fs.existsSync(resolveOracleDefaultConfigFile())
      ? resolveOracleDefaultConfigFile()
      : undefined);

  if (!configFile) {
    throw new Error(ORACLE_MISSING_CONFIG_FILE_ERROR);
  }

  const profile =
    trimToUndefined(params.profile) ??
    trimToUndefined(env.OCI_PROFILE) ??
    trimToUndefined(env.OCI_CLI_PROFILE) ??
    trimToUndefined(stored?.metadata.profile) ??
    DEFAULT_PROFILE_NAME;

  const validated = validateOracleConfigFileInternal(configFile, profile);
  const compartmentId =
    trimToUndefined(params.compartmentId) ??
    trimToUndefined(env.OCI_COMPARTMENT_ID) ??
    trimToUndefined(stored?.metadata.compartmentId) ??
    validated.tenancyId;

  return {
    ...validated,
    compartmentId,
  };
}

export function resolveStoredOracleAuth(params: {
  agentDir?: string;
  profileId?: string;
}): OracleResolvedAuth | null {
  const stored = loadStoredOracleProfile(params.agentDir, params.profileId);
  if (!stored) {
    return null;
  }
  return resolveOracleAuth({
    configFile: stored.configFile,
    profile: trimToUndefined(stored.metadata.profile),
    compartmentId: trimToUndefined(stored.metadata.compartmentId),
    allowStoredProfileFallback: false,
  });
}

type OracleRuntimeAuthTokenPayload = {
  v: 1;
  configFile: string;
  profile: string;
  compartmentId: string;
  tenancyId: string;
};

export function buildOracleRuntimeAuthToken(auth: OracleResolvedAuth): string {
  const payload: OracleRuntimeAuthTokenPayload = {
    v: 1,
    configFile: auth.configFile,
    profile: auth.profile,
    compartmentId: auth.compartmentId,
    tenancyId: auth.tenancyId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parseOracleRuntimeAuthToken(token: string): OracleResolvedAuth {
  try {
    const parsed = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as Partial<OracleRuntimeAuthTokenPayload>;
    const configFile = trimToUndefined(parsed.configFile);
    const profile = trimToUndefined(parsed.profile);
    const compartmentId = trimToUndefined(parsed.compartmentId);
    const tenancyId = trimToUndefined(parsed.tenancyId);
    if (parsed.v !== 1 || !configFile || !profile || !compartmentId || !tenancyId) {
      throw new Error("invalid payload");
    }
    return {
      configFile,
      profile,
      compartmentId,
      tenancyId,
    };
  } catch {
    throw new Error("Oracle runtime auth token is invalid.");
  }
}

function buildOracleProfileMetadata(auth: OracleResolvedAuth): Record<string, string> {
  return {
    profile: auth.profile,
    compartmentId: auth.compartmentId,
    tenancyId: auth.tenancyId,
  };
}

export function buildOracleMissingAuthMessage(): string {
  return [
    "Oracle OCI uses API key auth from your OCI SDK config file and private key.",
    "Set OCI_CONFIG_FILE, and optionally OCI_PROFILE / OCI_CLI_PROFILE plus OCI_COMPARTMENT_ID, or run provider auth setup for Oracle.",
  ].join(" ");
}

export async function runOracleAuthInteractive(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const env = resolveOracleEnv();
  const defaultConfigFile =
    trimToUndefined(env.OCI_CONFIG_FILE) ?? resolveOracleDefaultConfigFile();
  const defaultProfile =
    trimToUndefined(env.OCI_PROFILE) ??
    trimToUndefined(env.OCI_CLI_PROFILE) ??
    DEFAULT_PROFILE_NAME;
  const defaultCompartmentId = trimToUndefined(env.OCI_COMPARTMENT_ID) ?? "";

  await ctx.prompter.note(
    [
      "Oracle OCI Generative AI uses the OCI SDK config file and API signing key.",
      "Provide the config file path, profile, and an optional compartment OCID.",
      "If compartment is left blank, the tenancy OCID from the config profile will be used.",
    ].join("\n"),
    "Oracle OCI",
  );

  const configFileInput = await ctx.prompter.text({
    message: "OCI config file path",
    initialValue: defaultConfigFile,
    validate: (value: string) => {
      try {
        ensureReadableFile(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  const profileInput = await ctx.prompter.text({
    message: "OCI profile",
    initialValue: defaultProfile,
    validate: (value: string) => {
      try {
        validateOracleConfigFileInternal(configFileInput, value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  const compartmentIdInput = await ctx.prompter.text({
    message: "Compartment OCID (optional)",
    initialValue: defaultCompartmentId,
  });

  const auth = resolveOracleAuth({
    configFile: configFileInput,
    profile: profileInput,
    compartmentId: compartmentIdInput,
  });

  return {
    profiles: [
      {
        profileId: ORACLE_PROFILE_ID,
        credential: buildApiKeyCredential(
          ORACLE_PROVIDER_ID,
          auth.configFile,
          buildOracleProfileMetadata(auth),
        ),
      },
    ],
    notes:
      trimToUndefined(compartmentIdInput) === undefined
        ? [
            "No compartment was provided, so Oracle will use the tenancy OCID from the selected profile.",
          ]
        : undefined,
  };
}

export async function runOracleAuthNonInteractive(ctx: ProviderAuthMethodNonInteractiveContext) {
  const opts = ctx.opts as Record<string, unknown> | undefined;
  const auth = resolveOracleAuth({
    agentDir: ctx.agentDir,
    configFile: normalizeOptionalSecretInput(opts?.oracleConfigFile),
    profile: normalizeOptionalSecretInput(opts?.oracleProfile),
    compartmentId: normalizeOptionalSecretInput(opts?.oracleCompartmentId),
    env: resolveOracleEnv(),
    profileId: ORACLE_PROFILE_ID,
  });

  upsertAuthProfile({
    profileId: ORACLE_PROFILE_ID,
    credential: buildApiKeyCredential(
      ORACLE_PROVIDER_ID,
      auth.configFile,
      buildOracleProfileMetadata(auth),
    ),
    agentDir: ctx.agentDir,
  });

  return applyAuthProfileConfig(ctx.config, {
    profileId: ORACLE_PROFILE_ID,
    provider: ORACLE_PROVIDER_ID,
    mode: "api_key",
  });
}
