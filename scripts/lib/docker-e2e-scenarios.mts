// Docker E2E scenario catalog.
// Keep lane names, commands, image kind, timeout, resources, and release chunks
// here. Planning and execution live in separate modules.
import { fileURLToPath } from "node:url";
import {
  UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
  listRecordedFirstHopSourceVersions,
  updateFirstHopCompatLaneName,
} from "./update-first-hop-lanes.mjs";

export type DockerE2eImageKind = "bare" | "functional";
export type DockerE2eReleaseProfile = "beta" | "stable" | "full";
export type DockerE2eReleaseProfileInput = "minimum" | DockerE2eReleaseProfile;
export type DockerE2eLane = {
  cacheKey?: string;
  command: string;
  e2eImageKind?: DockerE2eImageKind;
  estimateSeconds?: number;
  live: boolean;
  name: string;
  needsPackage?: boolean;
  needsLiveImage?: boolean;
  noOutputTimeoutMs?: number;
  prepublishPluginPackages?: string[];
  resources: string[];
  stateScenario?: string;
  timeoutMs?: number;
  upgradeSurvivorScenario?: string;
  weight: number;
};
type LaneOptions = Partial<Omit<DockerE2eLane, "e2eImageKind" | "name">> & {
  e2eImageKind?: DockerE2eImageKind | false;
  provider?: string;
  providers?: string[];
};

const LIVE_DOCKER_DEFAULT_HARNESS_DIR =
  /[\\/]\.release-harness[\\/]/u.test(fileURLToPath(import.meta.url)) &&
  process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT
    ? ".release-harness"
    : ".";
const LIVE_ACP_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_CLI_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_PROFILE_TIMEOUT_MS = 30 * 60 * 1000;
const OPENWEBUI_TIMEOUT_MS = 20 * 60 * 1000;
const RELEASE_OPENWEBUI_COMMAND =
  "OPENCLAW_OPENWEBUI_MODEL=openai/gpt-5.4-mini OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui";
export const BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS = 24;
const upgradeSurvivorCommand = upgradeSurvivorScriptCommand();
// CI Docker seed runs this lane in auto-auth mode, so it carries the running-Gateway
// recovery update and needs the restart-auth budgets below. Hosted 4-vCPU seed runs
// measured 846s and 1054s passes, then 1515s and 1516s timeouts (CI 36496123315,
// 36519374717, in upgrade-survivor:recovery-update-restart). Testbox 8-vCPU: 627s
// lane, 325s recovery update; x ~2.4 hosted ratio => ~1505s, x ~1.5 => 2280s inner;
// add 300s host margin => 2580s lane. Recovery update: 325s x 2.4 ~= 780s (hosted
// 856s in 36506210440) against the 900s default, so use restart-auth's 1500s.
const publishedUpgradeSurvivorCommand = upgradeSurvivorScriptCommand(
  "OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT=1500s",
  'export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-openclaw@latest}"; export OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-2280s}"',
);
const rootManagedVpsUpgradeCommand = upgradeSurvivorScriptCommand(
  "OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS=1",
  'export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-openclaw@latest}"; export OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-1500s}"',
);
// Hosted release checks on 2026-10-06/07 passed in 1678-2290s (runs 37541402736,
// 37559852628, 37589651386) and were killed at the old 2280s inner cap in
// recovery-update-restart (37596230364, 37610648201): 2290s x ~1.5 => 3420s inner.
// Run 36506210440: restart update took 856s; Crabbox 4-CPU took 993s x ~1.5 => 1500s.
const updateRestartAuthCommand = upgradeSurvivorScriptCommand(
  "OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE=auto-auth OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT=1500s",
  'export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-openclaw@latest}"; export OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-3420s}"',
);
const updateMigrationCommand = upgradeSurvivorScriptCommand(
  "OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1",
  'export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-openclaw@latest}"; export OPENCLAW_UPGRADE_SURVIVOR_SCENARIO="${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-plugin-deps-cleanup}"',
);
const dreamingCronDoctorCommand = upgradeSurvivorScriptCommand(
  "OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=openclaw@2026.9.6 OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE=current OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=dreaming-cron-doctor OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE=manual OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS=0 OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS= OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=0",
);
const updateFirstHopCompatLaneOptions = {
  resources: ["service"],
  stateScenario: "upgrade-survivor",
  // Run 36506342273 (hosted 4-vCPU): projected 2125s x ~1.5 => 3200s inner;
  // add 300s for host-side fixtures, package preparation, and cleanup.
  timeoutMs: 3500 * 1000,
  // Limit npm/disk contention to two hops at npm limit 5; a weight-3 survivor can overlap one.
  weight: 2,
} satisfies LaneOptions;
// Keep source-derived hops separate while running the post-convergence edge case once.
const updateFirstHopCompatLanes = [
  ...listRecordedFirstHopSourceVersions().map((version) =>
    npmLane(updateFirstHopCompatLaneName(version), {
      ...updateFirstHopCompatLaneOptions,
      command: `OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 OPENCLAW_UPDATE_FIRST_HOP_SCENARIO=source OPENCLAW_UPDATE_FIRST_HOP_SOURCE_VERSIONS=${version} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-first-hop-compat`,
    }),
  ),
  npmLane(UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE, {
    ...updateFirstHopCompatLaneOptions,
    command:
      "OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 OPENCLAW_UPDATE_FIRST_HOP_SCENARIO=missing-load-path OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-first-hop-compat",
  }),
];
const CODEX_HARNESS_API_KEY_ENV = "OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key";
const npmOnboardLaneOptions = {
  prepublishPluginPackages: ["@openclaw/codex"],
  resources: ["service"],
  stateScenario: "empty",
  weight: 3,
} satisfies LaneOptions;

export function liveDockerScriptCommand(
  script: string,
  envPrefix = "",
  options: { shellPrelude?: string; skipBuild?: boolean } = {},
) {
  const prefix = envPrefix ? `${envPrefix} ` : "";
  const shellPrelude = options.shellPrelude ? `${options.shellPrelude}; ` : "";
  const skipBuild = options.skipBuild === false ? "" : "OPENCLAW_SKIP_DOCKER_BUILD=1 ";
  return `${prefix}${skipBuild}bash -c '${shellPrelude}harness="\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-${LIVE_DOCKER_DEFAULT_HARNESS_DIR}}"; OPENCLAW_LIVE_DOCKER_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" bash "$harness/scripts/${script}"'`;
}

function upgradeSurvivorScriptCommand(envPrefix = "", shellPrelude = "") {
  const rootPrefix = 'OPENCLAW_DOCKER_E2E_REPO_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}"';
  return liveDockerScriptCommand(
    "e2e/upgrade-survivor-docker.sh",
    envPrefix ? `${rootPrefix} ${envPrefix}` : rootPrefix,
    { shellPrelude },
  );
}

function lane(name: string, options: LaneOptions = {}): DockerE2eLane {
  return {
    cacheKey: options.cacheKey,
    command: options.command ?? `OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:${name}`,
    e2eImageKind:
      options.e2eImageKind === false
        ? undefined
        : (options.e2eImageKind ?? (options.live ? undefined : "functional")),
    estimateSeconds: options.estimateSeconds,
    live: options.live === true,
    noOutputTimeoutMs: options.noOutputTimeoutMs,
    name,
    ...(options.needsPackage ? { needsPackage: true } : {}),
    needsLiveImage: options.needsLiveImage,
    prepublishPluginPackages: options.prepublishPluginPackages,
    resources: options.resources ?? [],
    stateScenario: options.stateScenario,
    timeoutMs: options.timeoutMs,
    upgradeSurvivorScenario: options.upgradeSurvivorScenario,
    weight: options.weight ?? 1,
  };
}

function liveLane(name: string, options: LaneOptions = {}) {
  return lane(name, {
    ...options,
    live: true,
    // Package-backed live lanes use their E2E image; live credentials alone do
    // not require building the separate source live-test image.
    needsLiveImage: options.needsLiveImage ?? !options.e2eImageKind,
    resources: [
      "live",
      ...(options.providers ?? (options.provider ? [options.provider] : [])).map(
        (provider) =>
          `live:${provider === "claude-cli" ? "claude" : provider === "codex-cli" ? "codex" : provider === "google-gemini-cli" ? "gemini" : provider}`,
      ),
      ...(options.resources ?? []),
    ],
    weight: options.weight ?? 3,
  });
}

function npmLane(name: string, options: LaneOptions = {}) {
  return lane(name, {
    ...options,
    e2eImageKind: options.e2eImageKind ?? "bare",
    resources: ["npm", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

function serviceLane(name: string, options: LaneOptions = {}) {
  return lane(name, {
    ...options,
    resources: ["service", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

function codexHarnessLane(name: string, envPrefix: string) {
  return liveLane(name, {
    command: liveDockerScriptCommand("test-live-codex-harness-docker.sh", envPrefix),
    cacheKey: "codex-harness",
    provider: "openai",
    resources: ["npm"],
    timeoutMs: LIVE_ACP_TIMEOUT_MS,
  });
}

function upgradeSurvivorLane(
  name: string,
  command: string,
  timeoutMs: number,
  upgradeSurvivorScenario = "base",
) {
  return npmLane(name, {
    command,
    stateScenario: "upgrade-survivor",
    timeoutMs,
    upgradeSurvivorScenario,
    weight: 3,
  });
}

const bundledPluginInstallUninstallLanes = Array.from(
  { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
  (_, index) =>
    lane(`bundled-plugin-install-uninstall-${index}`, {
      command: `OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL=${BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS} OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=${index} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-plugin-install-uninstall`,
      estimateSeconds: 120,
      resources: ["npm"],
      stateScenario: "empty",
    }),
);

export const mainLanes: DockerE2eLane[] = [
  lane("container-image-upgrade", {
    command: "OPENCLAW_SKIP_DOCKER_BUILD=0 pnpm test:docker:container-image-upgrade",
    e2eImageKind: false,
    resources: ["docker", "service"],
    timeoutMs: 30 * 60 * 1000,
    weight: 4,
  }),
  lane("docker-selected-plugins", {
    command: "OPENCLAW_SKIP_DOCKER_BUILD=0 pnpm test:docker:selected-plugins",
    e2eImageKind: false,
    estimateSeconds: 600,
    resources: ["docker"],
    timeoutMs: 30 * 60 * 1000,
    weight: 4,
  }),
  serviceLane("compose-setup", {
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  npmLane("cli-installer-distribution", {
    stateScenario: "empty",
    timeoutMs: 30 * 60 * 1000,
    weight: 3,
  }),
  npmLane("docker-package-install", {
    command: "OPENCLAW_SKIP_DOCKER_BUILD=0 pnpm test:docker:package-install",
    e2eImageKind: false,
    needsPackage: true,
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  liveLane("live-models", {
    command: liveDockerScriptCommand("test-live-models-docker.sh"),
    providers: ["claude-cli", "google-gemini-cli"],
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane("live-anthropic-cache", {
    command: liveDockerScriptCommand("e2e/anthropic-cache-live-docker.sh"),
    e2eImageKind: "functional",
    provider: "claude",
    timeoutMs: 15 * 60 * 1000,
    weight: 2,
  }),
  liveLane("live-gateway", {
    command: liveDockerScriptCommand(
      "test-live-gateway-models-docker.sh",
      "OPENCLAW_LIVE_GATEWAY_PROVIDERS=claude-cli,google-gemini-cli",
    ),
    providers: ["claude-cli", "google-gemini-cli"],
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  ...[
    { agent: "claude", provider: "claude-cli", model: "claude-sonnet-4-6" },
    { agent: "gemini", provider: "google-gemini-cli", model: "gemini-3-flash-preview" },
  ].map(({ agent, provider, model }) =>
    liveLane(`live-cli-backend-${agent}`, {
      command: liveDockerScriptCommand(
        "test-live-cli-backend-docker.sh",
        `OPENCLAW_LIVE_CLI_BACKEND_MODEL=${provider}/${model}`,
      ),
      cacheKey: `cli-backend-${agent}`,
      provider,
      resources: ["npm"],
      timeoutMs: LIVE_CLI_TIMEOUT_MS,
    }),
  ),
  openWebUILane(),
  serviceLane("onboard", {
    stateScenario: "empty",
  }),
  npmLane("codex-on-demand", {
    prepublishPluginPackages: ["@openclaw/codex"],
    resources: ["service"],
    stateScenario: "empty",
    weight: 3,
  }),
  serviceLane("codex-media-path", {
    prepublishPluginPackages: ["@openclaw/codex"],
    resources: ["npm"],
    stateScenario: "empty",
    weight: 3,
  }),
  npmLane("npm-onboard-channel-agent", npmOnboardLaneOptions),
  ...["discord", "slack"].map((channel) =>
    npmLane(`npm-onboard-${channel}-channel-agent`, {
      ...npmOnboardLaneOptions,
      command: `OPENCLAW_NPM_ONBOARD_CHANNEL=${channel} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent`,
    }),
  ),
  // Prerelease validation must pair frozen core bytes with matching target plugin bytes.
  // The lanes above leave channel source selection to the published catalog.
  ...["discord", "slack"].map((channel) =>
    npmLane(`npm-onboard-${channel}-candidate-channel-agent`, {
      command: liveDockerScriptCommand(
        "e2e/npm-onboard-channel-agent-docker.sh",
        `OPENCLAW_NPM_ONBOARD_CHANNEL=${channel} OPENCLAW_NPM_ONBOARD_USE_SOURCE_PLUGIN_PACKAGE=1`,
      ),
      ...npmOnboardLaneOptions,
      prepublishPluginPackages: ["@openclaw/codex", `@openclaw/${channel}`],
    }),
  ),
  npmLane("release-user-journey", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 4,
  }),
  npmLane("release-typed-onboarding", {
    ...npmOnboardLaneOptions,
    timeoutMs: 20 * 60 * 1000,
  }),
  npmLane("release-media-memory", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  npmLane("release-upgrade-user-journey", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    timeoutMs: 30 * 60 * 1000,
    weight: 5,
  }),
  npmLane("release-plugin-marketplace", {
    resources: ["npm"],
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  serviceLane("gateway-concurrency", {
    command: liveDockerScriptCommand("e2e/gateway-concurrency-docker.sh"),
    timeoutMs: 10 * 60 * 1000,
    weight: 3,
  }),
  serviceLane("gateway-network"),
  serviceLane("browser-cdp-snapshot", {
    command: "pnpm test:docker:browser-cdp-snapshot",
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  serviceLane("sandbox-browser-sidecar", {
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
    weight: 4,
  }),
  serviceLane("agents-delete-shared-workspace", { stateScenario: "empty" }),
  serviceLane("mcp-channels", {
    resources: ["npm"],
    stateScenario: "empty",
    weight: 3,
  }),
  serviceLane("mcp-code-mode-gateway", {
    prepublishPluginPackages: ["@openclaw/codex"],
    resources: ["npm"],
    stateScenario: "empty",
    weight: 3,
  }),
  lane("agent-bundle-mcp-tools", {
    stateScenario: "empty",
  }),
  lane("system-agent-rescue", {
    stateScenario: "empty",
  }),
  serviceLane("cron-mcp-cleanup", { resources: ["npm"], stateScenario: "empty", weight: 3 }),
  npmLane("doctor-switch", {
    stateScenario: "empty",
    weight: 3,
  }),
  npmLane("update-channel-switch", {
    stateScenario: "update-stable",
    timeoutMs: 30 * 60 * 1000,
    weight: 3,
  }),
  npmLane("skill-install", {
    stateScenario: "empty",
    timeoutMs: 10 * 60 * 1000,
  }),
  upgradeSurvivorLane("upgrade-survivor", upgradeSurvivorCommand, 20 * 60 * 1000),
  upgradeSurvivorLane("published-upgrade-survivor", publishedUpgradeSurvivorCommand, 2580 * 1000),
  // Explicit Docker/release regression; the per-PR cell still runs only one real update.
  lane("published-driver-lifecycle", {
    command: "pnpm test:docker:published-driver-lifecycle",
    e2eImageKind: "bare",
    resources: ["service"],
    estimateSeconds: 15,
    timeoutMs: 10 * 60 * 1000,
  }),
  npmLane(
    "published-driver-update", // Outlives the script's 1125 s envelope; hosted after #162858: p50 521 s, max 659 s.
    { resources: ["service"], stateScenario: "empty", timeoutMs: 20 * 60 * 1000 },
  ),
  upgradeSurvivorLane(
    "dreaming-cron-doctor",
    dreamingCronDoctorCommand,
    25 * 60 * 1000,
    "dreaming-cron-doctor",
  ),
  upgradeSurvivorLane("root-managed-vps-upgrade", rootManagedVpsUpgradeCommand, 25 * 60 * 1000),
  // 3420s inner + 300s host-side margin.
  upgradeSurvivorLane("update-restart-auth", updateRestartAuthCommand, 3720 * 1000),
  ...updateFirstHopCompatLanes,
  upgradeSurvivorLane(
    "update-migration",
    updateMigrationCommand,
    30 * 60 * 1000,
    "plugin-deps-cleanup",
  ),
  lane("plugins", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    weight: 6,
  }),
  lane("kitchen-sink-plugin", {
    resources: ["npm"],
    stateScenario: "empty",
    weight: 3,
  }),
  serviceLane("kitchen-sink-rpc", {
    resources: ["npm"],
    stateScenario: "empty",
    timeoutMs: 25 * 60 * 1000,
    weight: 3,
  }),
  ...bundledPluginInstallUninstallLanes,
  lane("plugins-offline", {
    command: "OPENCLAW_PLUGINS_E2E_CLAWHUB=0 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
    resources: ["npm", "service"],
    stateScenario: "empty",
    weight: 6,
  }),
  npmLane("plugin-update", {
    stateScenario: "empty",
  }),
  npmLane("update-corrupt-plugin", {
    stateScenario: "empty",
    timeoutMs: 30 * 60 * 1000,
    weight: 3,
  }),
  npmLane("plugin-lifecycle-matrix", {
    stateScenario: "empty",
    timeoutMs: 12 * 60 * 1000,
  }),
  serviceLane("config-reload", {
    stateScenario: "empty",
  }),
  npmLane("multi-node-update", {
    stateScenario: "empty",
    timeoutMs: 15 * 60 * 1000,
    weight: 3,
  }),
  lane("openai-image-auth", {
    stateScenario: "empty",
  }),
  lane("system-agent-first-run", { stateScenario: "empty" }),
  lane("session-runtime-context", { resources: ["service"] }),
  lane("plugin-binding-command-escape", {
    command: "OPENCLAW_SKIP_DOCKER_BUILD=0 pnpm test:docker:plugin-binding-command-escape",
    e2eImageKind: false,
    resources: ["npm"],
    stateScenario: "empty",
  }),
  liveLane("npm-telegram-live", {
    e2eImageKind: "bare",
    provider: "openai",
    resources: ["live:telegram", "npm", "service"],
    timeoutMs: 30 * 60 * 1000,
  }),
  lane("qr", {
    command: "pnpm test:docker:qr",
  }),
];

export const tailLanes: DockerE2eLane[] = [
  serviceLane("openai-web-search-minimal", { stateScenario: "empty", timeoutMs: 8 * 60 * 1000 }),
  codexHarnessLane("live-codex-harness", CODEX_HARNESS_API_KEY_ENV),
  codexHarnessLane(
    "live-codex-media-path",
    "OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key OPENCLAW_LIVE_CODEX_HARNESS_CHAT_IMAGE_PROBE=1 OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=0",
  ),
  liveLane("live-subagent-announce", {
    command: liveDockerScriptCommand("test-live-subagent-announce-docker.sh"),
    cacheKey: "subagent-announce",
    provider: "openai",
    resources: ["npm"],
    timeoutMs: 25 * 60 * 1000,
  }),
  codexHarnessLane(
    "live-codex-bind",
    `${CODEX_HARNESS_API_KEY_ENV} OPENCLAW_LIVE_CODEX_BIND=1 OPENCLAW_LIVE_CODEX_TEST_FILES=src/gateway/gateway-codex-bind.live.test.ts`,
  ),
  liveLane("live-codex-npm-plugin", {
    command: liveDockerScriptCommand("e2e/codex-npm-plugin-live-docker.sh"),
    cacheKey: "codex-npm-plugin",
    e2eImageKind: "bare",
    provider: "openai",
    resources: ["npm"],
    stateScenario: "empty",
    timeoutMs: 30 * 60 * 1000,
  }),
  liveLane("live-mcp-code-mode-gateway", {
    cacheKey: "mcp-code-mode-gateway",
    e2eImageKind: "functional",
    prepublishPluginPackages: ["@openclaw/codex"],
    provider: "openai",
    resources: ["npm", "service"],
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
  }),
  liveLane("live-plugin-tool", {
    command:
      "OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-plugin-tool",
    cacheKey: "plugin-tool",
    e2eImageKind: "bare",
    provider: "openai",
    resources: ["npm"],
    stateScenario: "empty",
    timeoutMs: 20 * 60 * 1000,
  }),
  ...[
    { agent: "claude", provider: "claude-cli", requireTranscript: false },
    { agent: "codex", provider: "codex-cli", requireTranscript: false },
    { agent: "droid", provider: "droid", requireTranscript: true },
    { agent: "gemini", provider: "google-gemini-cli", requireTranscript: false },
    { agent: "opencode", provider: "opencode", requireTranscript: true },
  ].map(({ agent, provider, requireTranscript }) =>
    liveLane(`live-acp-bind-${agent}`, {
      command: liveDockerScriptCommand(
        "test-live-acp-bind-docker.sh",
        `OPENCLAW_LIVE_ACP_BIND_AGENT=${agent}${requireTranscript ? " OPENCLAW_LIVE_ACP_BIND_REQUIRE_TRANSCRIPT=1" : ""}`,
      ),
      cacheKey: `acp-bind-${agent}`,
      provider,
      resources: agent === "codex" ? ["live:openai", "npm"] : ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
    }),
  ),
];

const scheduledLaneByName = new Map<string, DockerE2eLane>();
for (const entry of [...mainLanes, ...tailLanes]) {
  if (scheduledLaneByName.has(entry.name)) {
    throw new Error(`duplicate scheduled Docker E2E lane: ${entry.name}`);
  }
  scheduledLaneByName.set(entry.name, entry);
}

function scheduledLane(name: string, overrides: Partial<DockerE2eLane> = {}) {
  const entry = scheduledLaneByName.get(name);
  if (!entry) {
    throw new Error(`unknown scheduled Docker E2E lane: ${name}`);
  }
  return { ...entry, ...overrides };
}

function scheduledLaneList(...names: string[]) {
  return names.map((name) => scheduledLane(name));
}

const releasePathPluginRuntimePluginLanes = scheduledLaneList("plugins");
const releasePathPluginRuntimeServiceLanes = scheduledLaneList(
  "cron-mcp-cleanup",
  "kitchen-sink-rpc",
  "openai-web-search-minimal",
  "live-plugin-tool",
);

const releasePathPluginRuntimeCoreLanes = [
  ...releasePathPluginRuntimePluginLanes,
  ...releasePathPluginRuntimeServiceLanes,
];

const releasePathPluginRuntimeLanes = [
  ...releasePathPluginRuntimePluginLanes,
  ...bundledPluginInstallUninstallLanes,
  ...releasePathPluginRuntimeServiceLanes,
];

const releasePathBundledChannelLanes = scheduledLaneList("plugin-update");

// Public installer smoke needs a published, immutable package version. Keep it
// selectable for post-publish verification, but out of frozen-candidate CI.
export const publicInstallerLanes: DockerE2eLane[] = [
  liveLane("install-e2e-openai", {
    command: liveDockerScriptCommand(
      "test-install-sh-e2e-docker.sh",
      "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=openai OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-openai:local OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE=0 OPENCLAW_INSTALL_E2E_OPENAI_MODEL=openai/gpt-5.4-mini OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS=120 OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS=120",
      { skipBuild: false },
    ),
    e2eImageKind: "bare",
    provider: "openai",
    resources: ["npm", "service"],
    timeoutMs: 15 * 60 * 1000,
  }),
  liveLane("install-e2e-anthropic", {
    command: liveDockerScriptCommand(
      "test-install-sh-e2e-docker.sh",
      "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=anthropic OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-anthropic:local",
      { skipBuild: false },
    ),
    e2eImageKind: "bare",
    provider: "claude",
    resources: ["npm", "service"],
  }),
];

const releasePathPackageUpdateOpenAiLanes = [
  liveLane("openai-chat-tools", {
    e2eImageKind: "functional",
    provider: "openai",
    resources: ["service"],
    stateScenario: "empty",
    timeoutMs: 10 * 60 * 1000,
    weight: 2,
  }),
  scheduledLane("live-codex-npm-plugin"),
  scheduledLane("codex-on-demand", { timeoutMs: 30 * 60 * 1000 }),
  scheduledLane("release-typed-onboarding"),
  scheduledLane("root-managed-vps-upgrade"),
];
const releasePathPackageUpdateRestartAuthLanes = scheduledLaneList("update-restart-auth");

// Balance the npm-limited rows without raising per-runner resource caps.
const releasePathPackageOnboardingLanes = scheduledLaneList(
  "npm-onboard-channel-agent",
  "npm-onboard-discord-channel-agent",
  "npm-onboard-slack-channel-agent",
  "doctor-switch",
  "skill-install",
);
const releasePathPackageMigrationLanes = scheduledLaneList(
  "update-channel-switch",
  "published-upgrade-survivor",
);
const releasePathPackageSelfUpgradeLanes = scheduledLaneList(
  "upgrade-survivor",
  ...updateFirstHopCompatLanes.map((entry) => entry.name),
);
const releasePathPackageUpdateCoreLanes = [
  ...releasePathPackageOnboardingLanes,
  ...releasePathPackageMigrationLanes,
  ...releasePathPackageSelfUpgradeLanes,
];

const primaryReleasePathChunks: Record<string, DockerE2eLane[]> = {
  core: [
    scheduledLane("qr", { command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:qr" }),
    ...scheduledLaneList(
      "onboard",
      "gateway-network",
      "config-reload",
      "session-runtime-context",
      "live-anthropic-cache",
      "plugin-binding-command-escape",
      "agent-bundle-mcp-tools",
      "mcp-channels",
      "mcp-code-mode-gateway",
    ),
  ],
  "package-update-openai": releasePathPackageUpdateOpenAiLanes,
  "package-update-restart-auth": releasePathPackageUpdateRestartAuthLanes,
  "package-update-onboarding": releasePathPackageOnboardingLanes,
  "package-update-migrations": releasePathPackageMigrationLanes,
  "package-update-self-upgrade": releasePathPackageSelfUpgradeLanes,
  "plugins-runtime-plugins": releasePathPluginRuntimePluginLanes,
  "plugins-runtime-services": releasePathPluginRuntimeServiceLanes,
  "plugins-runtime-install-a": bundledPluginInstallUninstallLanes.slice(0, 3),
  "plugins-runtime-install-b": bundledPluginInstallUninstallLanes.slice(3, 6),
  "plugins-runtime-install-c": bundledPluginInstallUninstallLanes.slice(6, 9),
  "plugins-runtime-install-d": bundledPluginInstallUninstallLanes.slice(9, 12),
  "plugins-runtime-install-e": bundledPluginInstallUninstallLanes.slice(12, 15),
  "plugins-runtime-install-f": bundledPluginInstallUninstallLanes.slice(15, 18),
  "plugins-runtime-install-g": bundledPluginInstallUninstallLanes.slice(18, 21),
  "plugins-runtime-install-h": bundledPluginInstallUninstallLanes.slice(21),
  openwebui: [],
};

const betaReleasePathChunks = new Set([
  "package-update-openai",
  "package-update-restart-auth",
  "package-update-onboarding",
  "package-update-migrations",
  "package-update-self-upgrade",
]);

const legacyReleasePathChunks: Record<string, DockerE2eLane[]> = {
  "package-update": [
    ...releasePathPackageUpdateOpenAiLanes,
    ...releasePathPackageUpdateRestartAuthLanes,
    ...releasePathPackageUpdateCoreLanes,
  ],
  "package-update-core": releasePathPackageUpdateCoreLanes,
  "plugins-runtime-core": releasePathPluginRuntimeCoreLanes,
  "plugins-runtime": releasePathPluginRuntimeLanes,
  "plugins-integrations": [...releasePathPluginRuntimeLanes, ...releasePathBundledChannelLanes],
  "bundled-channels": releasePathBundledChannelLanes,
};

export function normalizeReleaseProfile(raw: string | null | undefined): DockerE2eReleaseProfile {
  const profile = (raw ?? "stable").trim() || "stable";
  if (profile === "minimum") {
    return "beta";
  }
  if (profile === "beta" || profile === "stable" || profile === "full") {
    return profile;
  }
  throw new Error(
    `release profile must be one of: beta, stable, full. Got: ${JSON.stringify(raw)}`,
  );
}

function openWebUILane(command?: string) {
  return liveLane("openwebui", {
    command,
    e2eImageKind: "functional",
    provider: "openai",
    resources: ["service"],
    timeoutMs: OPENWEBUI_TIMEOUT_MS,
    weight: 5,
  });
}

export function releasePathChunkLanes(
  chunk: string,
  options: { includeOpenWebUI?: boolean; releaseProfile?: DockerE2eReleaseProfileInput } = {},
): DockerE2eLane[] {
  const base = primaryReleasePathChunks[chunk] ?? legacyReleasePathChunks[chunk];
  if (!base) {
    throw new Error(
      `OPENCLAW_DOCKER_ALL_CHUNK must be one of: ${[
        ...Object.keys(primaryReleasePathChunks),
        ...Object.keys(legacyReleasePathChunks),
      ].join(", ")}. Got: ${JSON.stringify(chunk)}`,
    );
  }
  const releaseProfile = normalizeReleaseProfile(options.releaseProfile);
  if (
    releaseProfile === "beta" &&
    Object.hasOwn(primaryReleasePathChunks, chunk) &&
    !betaReleasePathChunks.has(chunk)
  ) {
    return [];
  }
  if (chunk === "openwebui") {
    return options.includeOpenWebUI ? [openWebUILane(RELEASE_OPENWEBUI_COMMAND)] : [];
  }
  if (
    (chunk !== "plugins-runtime-core" &&
      chunk !== "plugins-runtime" &&
      chunk !== "plugins-integrations") ||
    !options.includeOpenWebUI
  ) {
    return base;
  }
  return [...base, openWebUILane(RELEASE_OPENWEBUI_COMMAND)];
}

export function allReleasePathLanes(
  options: Parameters<typeof releasePathChunkLanes>[1] = {},
): DockerE2eLane[] {
  const releaseProfile = normalizeReleaseProfile(options.releaseProfile);
  return Object.keys(primaryReleasePathChunks).flatMap((chunk) =>
    releasePathChunkLanes(chunk, {
      includeOpenWebUI: options.includeOpenWebUI,
      releaseProfile,
    }),
  );
}
