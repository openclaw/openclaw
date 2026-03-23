// Plugins listed here are excluded from the default build and must be installed
// separately via `openclaw plugins install <name>`.
//
// WhatsApp and ACPX were removed from this list to ease the transition to
// channels-as-plugins. Both are core functionality (primary messaging channel
// and ACP/Codex runtime) and have no published npm package yet, so excluding
// them from the default build leaves users with no install path.
export const optionalBundledClusters = [
  "diagnostics-otel",
  "diffs",
  "googlechat",
  "matrix",
  "memory-lancedb",
  "msteams",
  "nostr",
  "tlon",
  "twitch",
  "ui",
  "zalouser",
];

export const optionalBundledClusterSet = new Set(optionalBundledClusters);

export const OPTIONAL_BUNDLED_BUILD_ENV = "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED";

export function isOptionalBundledCluster(cluster) {
  return optionalBundledClusterSet.has(cluster);
}

export function shouldIncludeOptionalBundledClusters(env = process.env) {
  return env[OPTIONAL_BUNDLED_BUILD_ENV] === "1";
}

export function shouldBuildBundledCluster(cluster, env = process.env) {
  return shouldIncludeOptionalBundledClusters(env) || !isOptionalBundledCluster(cluster);
}
