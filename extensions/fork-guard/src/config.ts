/**
 * fork-guard — config types and schema.
 *
 * Blocklist entries may be plain strings (exact substring match, case-sensitive)
 * or regex literals in the form `/pattern/flags` (e.g. `/alpaca/i`).
 */

export type ForkGuardConfig = {
  enabled: boolean;
  /** Git remote URL substrings that trigger the guard. */
  blockedRepos: string[];
  /** Blocklist entries: plain strings or /regex/flags. */
  blocklist: string[];
  upstreamRemote: string;
  upstreamBranch: string;
};

export const DEFAULT_FORK_GUARD_CONFIG: ForkGuardConfig = {
  enabled: true,
  blockedRepos: ["kami-saia/openclaw"],
  blocklist: [
    "/home/damon",
    "1466839871162155171",
    "1469273412357718048",
    "1468677033801552075",
    "/alpaca/i",
    "/saiabets/i",
    "/kami-saia\\/saia-memory/i",
  ],
  upstreamRemote: "upstream",
  upstreamBranch: "main",
};

export function parseForkGuardConfig(raw: unknown): ForkGuardConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_FORK_GUARD_CONFIG };
  }
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : DEFAULT_FORK_GUARD_CONFIG.enabled,
    blockedRepos: Array.isArray(r["blockedRepos"])
      ? (r["blockedRepos"] as string[]).filter((x) => typeof x === "string")
      : DEFAULT_FORK_GUARD_CONFIG.blockedRepos,
    blocklist: Array.isArray(r["blocklist"])
      ? (r["blocklist"] as string[]).filter((x) => typeof x === "string")
      : DEFAULT_FORK_GUARD_CONFIG.blocklist,
    upstreamRemote:
      typeof r["upstreamRemote"] === "string"
        ? r["upstreamRemote"]
        : DEFAULT_FORK_GUARD_CONFIG.upstreamRemote,
    upstreamBranch:
      typeof r["upstreamBranch"] === "string"
        ? r["upstreamBranch"]
        : DEFAULT_FORK_GUARD_CONFIG.upstreamBranch,
  };
}
