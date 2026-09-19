import { isTestOnlyPath } from "./changed-path-facts.mjs";

const MCP_DOCKER_SEED_LANES = [
  "mcp-channels",
  "cron-mcp-cleanup",
  "mcp-code-mode-gateway",
] as const;
const DOCKER_SEED_LANE_ORDER = [
  ...MCP_DOCKER_SEED_LANES,
  "update-channel-switch",
  "fleet-cache",
  "published-upgrade-survivor",
] as const;
type DockerSeedLane = (typeof DOCKER_SEED_LANE_ORDER)[number];
const DOCKER_SEED_LANES_BY_PATH: Readonly<Record<string, readonly DockerSeedLane[]>> = {
  ".github/workflows/ci.yml": [...MCP_DOCKER_SEED_LANES, "published-upgrade-survivor"],
  "scripts/e2e/cron-mcp-cleanup-seed.ts": ["cron-mcp-cleanup"],
  "scripts/e2e/docker-openai-seed.ts": MCP_DOCKER_SEED_LANES,
  "scripts/e2e/fleet-cache-docker.sh": ["fleet-cache"],
  "scripts/e2e/lib/mcp-code-mode-probe-server.ts": ["mcp-code-mode-gateway"],
  "scripts/e2e/lib/mcp-code-mode/scenario.sh": ["mcp-code-mode-gateway"],
  "scripts/e2e/lib/update-channel-switch/assertions.mjs": ["update-channel-switch"],
  "scripts/e2e/mcp-channels-seed.ts": ["mcp-channels"],
  "scripts/e2e/mcp-code-mode-gateway-seed.ts": ["mcp-code-mode-gateway"],
  "scripts/e2e/update-channel-switch-docker.sh": ["update-channel-switch"],
  "scripts/lib/changed-path-facts.mjs": [...MCP_DOCKER_SEED_LANES, "published-upgrade-survivor"],
  "scripts/lib/ci-docker-seed-plan.mts": [...MCP_DOCKER_SEED_LANES, "published-upgrade-survivor"],
};
// Keep the whole state owner: both schema-version constants and future migrations
// must exercise an installed release's updater before they reach main.
const PUBLISHED_UPGRADE_OWNER_RE =
  /^src\/(?:cli\/update-cli\/|infra\/(?:update-|package-update-)|plugins\/update(?:-|\.ts$)|commands\/doctor|state\/)|^scripts\/e2e\/(?:upgrade-survivor|lib\/upgrade-survivor\/)|^scripts\/(?:resolve-upgrade-survivor-baselines\.mts|lib\/(?:docker-e2e-(?:plan|scenarios)|upgrade-survivor-[^/]+)\.(?:mjs|mts))$|^package\.json$/u;

export function resolveChangedDockerSeedLanes(changedPaths: string[]) {
  const selected = new Set<DockerSeedLane>();
  for (const changedPath of changedPaths) {
    const normalizedPath = changedPath.replaceAll("\\", "/");
    if (normalizedPath.startsWith("scripts/e2e/lib/fleet-cache/")) {
      selected.add("fleet-cache");
    }
    if (
      PUBLISHED_UPGRADE_OWNER_RE.test(normalizedPath) &&
      (!normalizedPath.startsWith("src/") || !isTestOnlyPath(normalizedPath))
    ) {
      selected.add("published-upgrade-survivor");
    }
    for (const lane of DOCKER_SEED_LANES_BY_PATH[normalizedPath] ?? []) {
      selected.add(lane);
    }
  }
  return DOCKER_SEED_LANE_ORDER.filter((lane) => selected.has(lane));
}
