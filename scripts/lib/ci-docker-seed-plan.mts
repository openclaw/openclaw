const MAIN_DOCKER_SEED_LANES = ["published-upgrade-survivor"] as const;
const OWNER_DOCKER_SEED_LANES = [
  "mcp-channels",
  "cron-mcp-cleanup",
  "mcp-code-mode-gateway",
  "update-channel-switch",
  "fleet-cache",
] as const;

export function resolveDockerSeedLanes(options: { includeReleaseOnly: boolean }) {
  return options.includeReleaseOnly
    ? [...MAIN_DOCKER_SEED_LANES, ...OWNER_DOCKER_SEED_LANES]
    : [...MAIN_DOCKER_SEED_LANES];
}

// The published-driver tripwire runs intact in hourly main and full release
// validation. PRs retain the other Docker lanes through their owner map.
const MCP_DOCKER_SEED_LANES = [
  "mcp-channels",
  "cron-mcp-cleanup",
  "mcp-code-mode-gateway",
] as const;
type DockerSeedLane = (typeof OWNER_DOCKER_SEED_LANES)[number];
const DOCKER_SEED_LANES_BY_PATH: Readonly<Record<string, readonly DockerSeedLane[]>> = {
  ".github/workflows/ci.yml": MCP_DOCKER_SEED_LANES,
  "scripts/e2e/cron-mcp-cleanup-seed.ts": ["cron-mcp-cleanup"],
  "scripts/e2e/docker-openai-seed.ts": MCP_DOCKER_SEED_LANES,
  "scripts/e2e/fleet-cache-docker.sh": ["fleet-cache"],
  "scripts/e2e/lib/mcp-code-mode-probe-server.ts": ["mcp-code-mode-gateway"],
  "scripts/e2e/lib/mcp-code-mode/scenario.sh": ["mcp-code-mode-gateway"],
  "scripts/e2e/lib/update-channel-switch/assertions.mjs": ["update-channel-switch"],
  "scripts/e2e/mcp-channels-seed.ts": ["mcp-channels"],
  "scripts/e2e/mcp-code-mode-gateway-seed.ts": ["mcp-code-mode-gateway"],
  "scripts/e2e/update-channel-switch-docker.sh": ["update-channel-switch"],
  "scripts/lib/changed-path-facts.mjs": MCP_DOCKER_SEED_LANES,
  "scripts/lib/ci-docker-seed-plan.mts": MCP_DOCKER_SEED_LANES,
  "src/agents/embedded-agent-runner/run/attempt-bundle-tools.ts": ["mcp-code-mode-gateway"],
  "src/agents/runtime-plan/tools.ts": ["mcp-code-mode-gateway"],
};
export function resolveChangedDockerSeedLanes(changedPaths: string[]) {
  const selected = new Set<DockerSeedLane>();
  for (const changedPath of changedPaths) {
    const normalizedPath = changedPath.replaceAll("\\", "/");
    if (normalizedPath.startsWith("scripts/e2e/lib/fleet-cache/")) {
      selected.add("fleet-cache");
    }
    for (const lane of DOCKER_SEED_LANES_BY_PATH[normalizedPath] ?? []) {
      selected.add(lane);
    }
  }
  return OWNER_DOCKER_SEED_LANES.filter((lane) => selected.has(lane));
}
