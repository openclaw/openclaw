import { posix as posixPath, win32 as win32Path } from "node:path";

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32Path : posixPath;
}

// Detects the case where `gh` is authenticated under one HOME but the current
// OpenClaw process is running with a different HOME (e.g. the per-agent
// codex-home, a systemd service home, or a sudo'd shell). Without GH_CONFIG_DIR
// the gh CLI looks at $XDG_CONFIG_HOME/gh or $HOME/.config/gh and reports
// "not logged in", even though the operator HOME may have a valid hosts.yml.
//
// This helper intentionally does not guess broad operator-home paths by
// default. Operators who want this diagnostic can provide explicit candidate
// homes through candidateOperatorHomes in tests/callers or through the
// OPENCLAW_GH_CONFIG_DISCOVERY_HOMES environment variable in production. The
// diagnostic still only suggests setting GH_CONFIG_DIR; it never reads or copies
// GitHub CLI auth material.
// See https://github.com/openclaw/openclaw/issues/78063.

export type GhConfigDiscoveryEnv = {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  GH_CONFIG_DIR?: string;
  APPDATA?: string;
  SUDO_USER?: string;
  USER?: string;
  USERPROFILE?: string;
  OPENCLAW_GH_CONFIG_DISCOVERY_HOMES?: string;
};

export type GhConfigDiscoveryInput = {
  platform: NodeJS.Platform;
  env: GhConfigDiscoveryEnv;
  fileExists: (absolutePath: string) => boolean;
  // Optional: explicit operator-home directories to consider when looking for
  // an alternate gh config dir. Defaults to the opt-in
  // OPENCLAW_GH_CONFIG_DISCOVERY_HOMES env value; if that is unset, no
  // alternate homes are probed.
  candidateOperatorHomes?: readonly string[];
};

export type GhConfigDirMismatch = {
  // The directory `gh` would actually consult given the current process env.
  effectiveConfigDir: string;
  // The directory that contains the operator's real `hosts.yml`.
  alternateConfigDir: string;
  // Absolute path to the alternate hosts.yml that the current process won't see.
  alternateHostsFile: string;
  // The HOME-like path the alternate dir was derived from, if known.
  alternateHomeHint?: string;
  // Suggested env value the operator should set on the OpenClaw service to
  // surface the alternate config to the agent shell.
  suggestedEnvValue: string;
};

export type GhConfigDiscoveryResult =
  | { kind: "no-gh-binary" }
  | { kind: "explicit-gh-config-dir-set"; ghConfigDir: string }
  | { kind: "no-process-home" }
  | { kind: "auth-discoverable"; effectiveConfigDir: string }
  | { kind: "no-known-auth"; effectiveConfigDir: string }
  | ({ kind: "mismatch" } & GhConfigDirMismatch);

const HOSTS_FILE = "hosts.yml";
const OPERATOR_HOMES_ENV = "OPENCLAW_GH_CONFIG_DISCOVERY_HOMES";

// gh config-dir lookup order, matching `gh help environment`.
function resolveEffectiveGhConfigDir(input: GhConfigDiscoveryInput): string | undefined {
  const env = input.env;
  if (env.GH_CONFIG_DIR && env.GH_CONFIG_DIR.trim()) {
    return env.GH_CONFIG_DIR.trim();
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return pathFor(input.platform).join(xdg, "gh");
  }
  if (input.platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) {
      return pathFor(input.platform).join(appData, "GitHub CLI");
    }
    const profile = env.USERPROFILE?.trim();
    if (profile) {
      return pathFor(input.platform).join(profile, "AppData", "Roaming", "GitHub CLI");
    }
  }
  const home = env.HOME?.trim();
  if (!home) {
    return undefined;
  }
  return pathFor(input.platform).join(home, ".config", "gh");
}

function parseExplicitCandidateOperatorHomes(
  value: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (!value?.trim()) {
    return [];
  }
  const pathApi = pathFor(platform);
  return value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => pathApi.isAbsolute(entry));
}

function defaultCandidateOperatorHomes(input: GhConfigDiscoveryInput): string[] {
  const homes = new Set(
    parseExplicitCandidateOperatorHomes(
      input.env.OPENCLAW_GH_CONFIG_DISCOVERY_HOMES,
      input.platform,
    ),
  );
  // Drop the current process HOME from the candidate set; we want directories
  // that are NOT what gh would already consult.
  const processHome = input.env.HOME?.trim();
  if (processHome) {
    homes.delete(processHome);
  }
  return [...homes];
}

function ghConfigDirForHome(home: string, platform: NodeJS.Platform): string {
  // Linux and macOS both put gh's config under <HOME>/.config/gh. Windows is
  // not a realistic mismatch case for the bug this helper detects; we still
  // return the POSIX-layout directory so the hint points at a sensible path.
  return pathFor(platform).join(home, ".config", "gh");
}

export function detectGhConfigDirMismatch(input: GhConfigDiscoveryInput): GhConfigDiscoveryResult {
  const env = input.env;
  if (env.GH_CONFIG_DIR && env.GH_CONFIG_DIR.trim()) {
    return { kind: "explicit-gh-config-dir-set", ghConfigDir: env.GH_CONFIG_DIR.trim() };
  }
  const effective = resolveEffectiveGhConfigDir(input);
  if (!effective) {
    return { kind: "no-process-home" };
  }
  const effectiveHosts = pathFor(input.platform).join(effective, HOSTS_FILE);
  if (input.fileExists(effectiveHosts)) {
    return { kind: "auth-discoverable", effectiveConfigDir: effective };
  }
  const candidates = input.candidateOperatorHomes ?? defaultCandidateOperatorHomes(input);
  for (const home of candidates) {
    const candidateDir = ghConfigDirForHome(home, input.platform);
    if (candidateDir === effective) {
      continue;
    }
    const candidateHosts = pathFor(input.platform).join(candidateDir, HOSTS_FILE);
    if (input.fileExists(candidateHosts)) {
      return {
        kind: "mismatch",
        effectiveConfigDir: effective,
        alternateConfigDir: candidateDir,
        alternateHostsFile: candidateHosts,
        alternateHomeHint: home,
        suggestedEnvValue: candidateDir,
      };
    }
  }
  return { kind: "no-known-auth", effectiveConfigDir: effective };
}

export function formatGhConfigDirMismatchHint(mismatch: GhConfigDirMismatch): string[] {
  const lines: string[] = [
    "GitHub CLI auth was found at a different HOME than the one this OpenClaw process uses.",
    `  Process gh config dir: ${mismatch.effectiveConfigDir}`,
    `  Authenticated config:  ${mismatch.alternateConfigDir} (contains ${HOSTS_FILE})`,
  ];
  if (mismatch.alternateHomeHint) {
    lines.push(`  Authenticated HOME:    ${mismatch.alternateHomeHint}`);
  }
  lines.push(
    `  Fix: set GH_CONFIG_DIR=${mismatch.suggestedEnvValue} on the OpenClaw service environment, then restart the gateway.`,
    `  Optional diagnostic: set ${OPERATOR_HOMES_ENV}=<absolute-home> to check this path again.`,
  );
  return lines;
}
