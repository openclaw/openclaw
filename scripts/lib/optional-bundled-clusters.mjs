export const optionalBundledClusters = [
  "acpx",
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
  "whatsapp",
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

export function hasReleasedBundledInstall(packageJson) {
  return (
    typeof packageJson?.openclaw?.install?.npmSpec === "string" &&
    packageJson.openclaw.install.npmSpec.trim().length > 0
  );
}

export function shouldBuildBundledCluster(cluster, env = process.env, options = {}) {
  if (hasReleasedBundledInstall(options.packageJson)) {
    return true;
  }
  return shouldIncludeOptionalBundledClusters(env) || !isOptionalBundledCluster(cluster);
}
