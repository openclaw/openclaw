const MAIN_DOCKER_SEED_LANES = ["published-upgrade-survivor"] as const;
const RELEASE_ONLY_DOCKER_SEED_LANES = [
  "mcp-channels",
  "cron-mcp-cleanup",
  "mcp-code-mode-gateway",
  "update-channel-switch",
  "fleet-cache",
] as const;

export function resolveDockerSeedLanes(options: { includeReleaseOnly: boolean }) {
  return options.includeReleaseOnly
    ? [...MAIN_DOCKER_SEED_LANES, ...RELEASE_ONLY_DOCKER_SEED_LANES]
    : [...MAIN_DOCKER_SEED_LANES];
}
