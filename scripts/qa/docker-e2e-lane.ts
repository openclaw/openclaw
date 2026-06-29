// Runs an existing Docker E2E lane through the QA Lab script scenario contract.
import { spawnSync } from "node:child_process";

type Lane = {
  env?: Record<string, string>;
  script: string;
};

const lanes: Record<string, Lane> = {
  "agent-bundle-mcp-tools": {
    script: "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
  },
  "agents-delete-shared-workspace": {
    script: "scripts/e2e/agents-delete-shared-workspace-docker.sh",
  },
  "crestodian-first-run": {
    script: "scripts/e2e/crestodian-first-run-docker.sh",
  },
  "gateway-network": {
    script: "scripts/e2e/gateway-network-docker.sh",
  },
  "npm-onboard-channel-agent": {
    script: "scripts/e2e/npm-onboard-channel-agent-docker.sh",
  },
  "release-upgrade-user-journey": {
    script: "scripts/e2e/release-upgrade-user-journey-docker.sh",
  },
  "release-user-journey": {
    script: "scripts/e2e/release-user-journey-docker.sh",
  },
  "update-channel-switch": {
    script: "scripts/e2e/update-channel-switch-docker.sh",
  },
  "update-migration": {
    env: {
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:
        process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC ?? "openclaw@2026.4.23",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:
        process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO ?? "plugin-deps-cleanup",
    },
    script: "scripts/e2e/upgrade-survivor-docker.sh",
  },
  "update-restart-auth": {
    env: {
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
      OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:
        process.env.OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT ?? "1500s",
    },
    script: "scripts/e2e/upgrade-survivor-docker.sh",
  },
  "upgrade-survivor": {
    script: "scripts/e2e/upgrade-survivor-docker.sh",
  },
};

function laneArg(argv: string[]) {
  const index = argv.indexOf("--lane");
  if (index === -1) {
    throw new Error("--lane is required");
  }
  const lane = argv[index + 1];
  if (!lane || lane.startsWith("-")) {
    throw new Error("--lane requires a value");
  }
  return lane;
}

const laneName = laneArg(process.argv.slice(2));
const lane = lanes[laneName];
if (!lane) {
  throw new Error(`unknown Docker E2E lane: ${laneName}`);
}

const result = spawnSync("bash", [lane.script], {
  env: { ...process.env, ...lane.env },
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
