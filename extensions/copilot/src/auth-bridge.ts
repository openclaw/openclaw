import { createHash } from "node:crypto";
import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";

// The host resolves auth profiles; this adapter owns Copilot overrides, environment
// fallback, and per-agent CLI state. Credential fingerprints invalidate pooled clients.

const COPILOT_TOKEN_PROFILE_ERROR =
  "[copilot-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)";

const COPILOT_DEFAULT_AGENT_ID = "copilot";

interface ResolvedCopilotAuth {
  authMode: "useLoggedInUser" | "gitHubToken" | "byok";
  /** Present only when authMode is "gitHubToken". */
  gitHubToken?: string;
  /** Present for token and BYOK auth modes. */
  authProfileId?: string;
  /** Present for token and BYOK auth modes. */
  authProfileVersion?: string;
  /** Absolute, normalized path. */
  copilotHome: string;
  /** Validated agent id used for path defaults and pool keying. */
  agentId: string;
}

type CopilotSessionAuth = Pick<
  ResolvedCopilotAuth,
  "authMode" | "authProfileId" | "authProfileVersion"
>;

export function sessionAuthFields(auth: CopilotSessionAuth): CopilotSessionAuth {
  return auth.authMode === "gitHubToken" || auth.authMode === "byok"
    ? {
        authMode: auth.authMode,
        authProfileId: auth.authProfileId,
        authProfileVersion: auth.authProfileVersion,
      }
    : { authMode: "useLoggedInUser" };
}

export function sessionAuthMatches(
  stored: CopilotSessionAuth,
  current: CopilotSessionAuth,
): boolean {
  if (stored.authMode !== current.authMode) {
    return false;
  }
  if (stored.authMode === "useLoggedInUser") {
    return true;
  }
  return (
    stored.authProfileId === current.authProfileId &&
    stored.authProfileVersion === current.authProfileVersion
  );
}

export function createCopilotByokAuth(
  input: Pick<ResolveCopilotAuthInput, "agentId" | "agentDir" | "copilotHome" | "authProfileId"> & {
    authProfileVersion?: string;
  },
): ResolvedCopilotAuth {
  const base = resolveCopilotAuth({
    agentId: input.agentId,
    agentDir: input.agentDir,
    copilotHome: input.copilotHome,
    auth: { useLoggedInUser: true },
  });
  return {
    ...base,
    authMode: "byok",
    authProfileId: input.authProfileId?.trim() || "byok:resolved",
    authProfileVersion: input.authProfileVersion?.trim() || "byok:unfingerprinted",
  };
}

interface ResolveCopilotAuthInput {
  agentId?: string;
  agentDir?: string;
  copilotHome?: string;
  auth?: {
    gitHubToken?: string;
    useLoggedInUser?: boolean;
    profileId?: string;
    profileVersion?: string;
  };
  /** Token resolved by the host's auth-profile owner. */
  resolvedApiKey?: string;
  /** Keeps clients with different auth profiles in separate pool entries. */
  authProfileId?: string;
  /** Explicit-token caller fallback; host-resolved tokens use their fingerprint. */
  profileVersion?: string;
}

export function resolveCopilotAuth(input: ResolveCopilotAuthInput): ResolvedCopilotAuth {
  const agentId = sanitizeAgentId(input.agentId);
  const copilotHome = resolveCopilotHome({
    explicit: readNonEmptyString(input.copilotHome),
    agentDir: readNonEmptyString(input.agentDir),
    agentId,
  });

  const explicitToken = readNonEmptyString(input.auth?.gitHubToken);
  const explicitProfileId =
    readNonEmptyString(input.auth?.profileId) ?? readNonEmptyString(input.authProfileId);
  const explicitProfileVersion =
    readNonEmptyString(input.auth?.profileVersion) ?? readNonEmptyString(input.profileVersion);

  if (input.auth?.useLoggedInUser === true) {
    return {
      authMode: "useLoggedInUser",
      copilotHome,
      agentId,
    };
  }

  if (explicitToken) {
    if (!explicitProfileId || !explicitProfileVersion) {
      throw new Error(COPILOT_TOKEN_PROFILE_ERROR);
    }
    return {
      authMode: "gitHubToken",
      gitHubToken: explicitToken,
      authProfileId: explicitProfileId,
      authProfileVersion: explicitProfileVersion,
      copilotHome,
      agentId,
    };
  }

  const contractToken = readNonEmptyString(input.resolvedApiKey);
  if (contractToken) {
    const contractProfileId = readNonEmptyString(input.authProfileId);
    return {
      authMode: "gitHubToken",
      gitHubToken: contractToken,
      authProfileId: contractProfileId ?? "pi:resolved",
      authProfileVersion: tokenFingerprint(contractToken),
      copilotHome,
      agentId,
    };
  }

  const envFallback = readEnvTokenFallback();
  if (envFallback) {
    return {
      authMode: "gitHubToken",
      gitHubToken: envFallback.token,
      authProfileId: envFallback.profileId,
      authProfileVersion: envFallback.profileVersion,
      copilotHome,
      agentId,
    };
  }

  return {
    authMode: "useLoggedInUser",
    copilotHome,
    agentId,
  };
}

// Invalid ids use the harness default rather than entering a filesystem path.
function sanitizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed) ? trimmed : COPILOT_DEFAULT_AGENT_ID;
}

function resolveCopilotHome(args: {
  explicit: string | undefined;
  agentDir: string | undefined;
  agentId: string;
}): string {
  if (args.explicit) {
    return resolve(args.explicit);
  }
  // Keep CLI state separate from the host's files in the same agent directory.
  if (args.agentDir) {
    return resolve(join(args.agentDir, "copilot"));
  }

  const openClawHome = readNonEmptyString(process.env.OPENCLAW_HOME);
  const rootHome = openClawHome ? resolve(openClawHome) : osHomedir();
  return resolve(join(rootHome, ".openclaw", "agents", args.agentId, "copilot"));
}

function readEnvTokenFallback():
  | { token: string; profileId: string; profileVersion: string }
  | undefined {
  const env = process.env;
  const candidates: Array<{ name: string; value: string | undefined }> = [
    { name: "OPENCLAW_GITHUB_TOKEN", value: readNonEmptyString(env.OPENCLAW_GITHUB_TOKEN) },
    { name: "COPILOT_GITHUB_TOKEN", value: readNonEmptyString(env.COPILOT_GITHUB_TOKEN) },
    { name: "GH_TOKEN", value: readNonEmptyString(env.GH_TOKEN) },
    { name: "GITHUB_TOKEN", value: readNonEmptyString(env.GITHUB_TOKEN) },
  ];
  for (const { name, value } of candidates) {
    if (value) {
      return {
        token: value,
        profileId: `env:${name}`,
        profileVersion: tokenFingerprint(value),
      };
    }
  }
  return undefined;
}

/** Pool invalidation fingerprint; never log it alongside an account id. */
export function tokenFingerprint(token: string): string {
  const hex = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `sha256:${hex}`;
}
