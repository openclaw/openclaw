// Plans release workflow matrix entries from profile and suite inputs.
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parseLaneSelection } from "./lib/docker-e2e-plan.mts";
import { allReleasePathLanes } from "./lib/docker-e2e-scenarios.mts";
import { createPluginPrereleaseTestPlan } from "./lib/plugin-prerelease-test-plan.mts";
import { planTargetedDockerLaneGroups } from "./plan-targeted-docker-lane-groups.mjs";

export const RELEASE_PACKAGE_ACCEPTANCE_LANES =
  "release-typed-onboarding doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor update-first-hop-compat published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape";

const DOCKER_E2E_CHUNKS = [
  {
    chunk_id: "core",
    label: "core",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "package-update-openai",
    label: "package/update OpenAI and recovery",
    timeout_minutes: 45,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "package-update-onboarding",
    label: "package/update onboarding",
    timeout_minutes: 60,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "package-update-migrations",
    label: "package/update migrations",
    timeout_minutes: 60,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "package-update-self-upgrade",
    label: "package/update self-upgrade",
    timeout_minutes: 60,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "plugins-runtime-plugins",
    label: "plugins/runtime plugins",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-services",
    label: "plugins/runtime services",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-a",
    label: "plugins/runtime install A",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-b",
    label: "plugins/runtime install B",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-c",
    label: "plugins/runtime install C",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-d",
    label: "plugins/runtime install D",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-e",
    label: "plugins/runtime install E",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-f",
    label: "plugins/runtime install F",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-g",
    label: "plugins/runtime install G",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-h",
    label: "plugins/runtime install H",
    timeout_minutes: 60,
    profiles: "stable full",
  },
];

const LIVE_MODEL_PROVIDERS = [
  {
    provider_label: "Anthropic",
    providers: "anthropic",
    profiles: "stable full",
  },
  {
    provider_label: "Google",
    providers: "google",
    profiles: "stable full",
  },
  {
    provider_label: "MiniMax",
    providers: "minimax",
    models: "minimax/MiniMax-M3,minimax-portal/MiniMax-M3",
    max_models: "2",
    profiles: "stable full",
  },
  {
    provider_label: "Moonshot",
    providers: "moonshot",
    profiles: "full",
  },
  {
    provider_label: "OpenAI",
    providers: "openai",
    profiles: "beta minimum stable full",
  },
  {
    provider_label: "OpenCode",
    providers: "opencode-go",
    profiles: "full",
  },
  {
    provider_label: "OpenRouter",
    providers: "openrouter",
    profiles: "full",
  },
  {
    provider_label: "xAI",
    providers: "xai",
    profiles: "full",
  },
  {
    provider_label: "Z.ai",
    providers: "zai",
    profiles: "full",
  },
  {
    provider_label: "Fireworks",
    providers: "fireworks",
    profiles: "full",
  },
];

const LIVE_DOCKER_SUITES = [
  {
    suite_id: "live-gateway-docker",
    label: "Docker live gateway OpenAI",
    command:
      'OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.6-luna OPENCLAW_LIVE_GATEWAY_MAX_MODELS=1 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "beta minimum stable full",
  },
  {
    suite_id: "live-gateway-anthropic-docker",
    suite_group: "live-gateway-anthropic-docker",
    label: "Docker live gateway Anthropic",
    command:
      'OPENCLAW_LIVE_GATEWAY_THINKING=low OPENCLAW_LIVE_GATEWAY_PROVIDERS=anthropic OPENCLAW_LIVE_GATEWAY_MODELS=anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable",
  },
  {
    suite_id: "live-gateway-anthropic-docker-full",
    suite_group: "live-gateway-anthropic-docker",
    label: "Docker live gateway Anthropic (full advisory)",
    command:
      'OPENCLAW_LIVE_GATEWAY_THINKING=low OPENCLAW_LIVE_GATEWAY_PROVIDERS=anthropic OPENCLAW_LIVE_GATEWAY_MODELS=anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    advisory: true,
    profiles: "full",
  },
  {
    suite_id: "live-gateway-google-docker",
    label: "Docker live gateway Google",
    command:
      'OPENCLAW_LIVE_GATEWAY_PROVIDERS=google OPENCLAW_LIVE_GATEWAY_MODELS=google/gemini-3.1-pro-preview OPENCLAW_LIVE_GATEWAY_MAX_MODELS=1 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=180000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-gateway-minimax-docker",
    label: "Docker live gateway MiniMax",
    command:
      'OPENCLAW_LIVE_GATEWAY_PROVIDERS=minimax,minimax-portal OPENCLAW_LIVE_GATEWAY_MODELS=minimax/MiniMax-M3,minimax-portal/MiniMax-M3 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=180000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-gateway-advisory-docker-deepseek-fireworks",
    suite_group: "live-gateway-advisory-docker",
    label: "Docker live gateway advisory DeepSeek/Fireworks",
    command:
      'OPENCLAW_LIVE_GATEWAY_PROVIDERS=deepseek,fireworks OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=180000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    advisory: true,
    profiles: "full",
  },
  {
    suite_id: "live-gateway-advisory-docker-opencode-openrouter",
    suite_group: "live-gateway-advisory-docker",
    label: "Docker live gateway advisory OpenCode/OpenRouter",
    command:
      'OPENCLAW_LIVE_GATEWAY_PROVIDERS=opencode-go,openrouter OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=180000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    advisory: true,
    profiles: "full",
  },
  {
    suite_id: "live-gateway-advisory-docker-xai-zai",
    suite_group: "live-gateway-advisory-docker",
    label: "Docker live gateway advisory xAI/Z.ai",
    command:
      'OPENCLAW_LIVE_GATEWAY_PROVIDERS=xai,zai OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=180000 OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-gateway-models-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    advisory: true,
    profiles: "full",
  },
  {
    suite_id: "live-cli-backend-docker",
    label: "Docker live CLI backend",
    command:
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 45m bash .release-harness/scripts/test-live-cli-backend-docker.sh',
    timeout_minutes: 50,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-cli-cache-docker",
    label: "Docker live Claude CLI prompt cache",
    command:
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 45m bash .release-harness/scripts/test-live-cli-backend-docker.sh',
    timeout_minutes: 50,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-acp-bind-docker",
    label: "Docker live ACP bind",
    command:
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 45m bash .release-harness/scripts/test-live-acp-bind-docker.sh',
    timeout_minutes: 50,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-codex-harness-docker",
    label: "Docker live Codex harness",
    command:
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-codex-harness-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-codex-harness-gpt56-sol-docker",
    suite_group: "live-codex-harness-gpt56-docker",
    label: "Docker live Codex GPT-5.6 Sol Ultra",
    command:
      'OPENCLAW_LIVE_CODEX_HARNESS_TARGETS=openai/gpt-5.6-sol=ultra OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-codex-harness-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-codex-harness-gpt56-terra-docker",
    suite_group: "live-codex-harness-gpt56-docker",
    label: "Docker live Codex GPT-5.6 Terra Ultra",
    command:
      'OPENCLAW_LIVE_CODEX_HARNESS_TARGETS=openai/gpt-5.6-terra=ultra OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-codex-harness-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-codex-harness-gpt56-luna-docker",
    suite_group: "live-codex-harness-gpt56-docker",
    label: "Docker live Codex GPT-5.6 Luna Max",
    command:
      'OPENCLAW_LIVE_CODEX_HARNESS_TARGETS=openai/gpt-5.6-luna=max OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-codex-harness-docker.sh',
    timeout_minutes: 40,
    profile_env_only: false,
    profiles: "stable full",
  },
  {
    suite_id: "live-subagent-announce-docker",
    label: "Docker live subagent announce",
    command:
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 20m bash .release-harness/scripts/test-live-subagent-announce-docker.sh',
    timeout_minutes: 25,
    profile_env_only: false,
    profiles: "stable full",
  },
];

function isEnabled(value) {
  return value === true || value === "true";
}

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function profileIncludes(entry, profile) {
  return entry.profiles.split(/\s+/u).includes(profile);
}

/** The release-check job predicates, shared with its admission prerequisite. */
export function createReleaseCheckSelection(options = {}) {
  const phase = options.phase ?? "all";
  if (!["all", "independent", "candidate"].includes(phase)) {
    throw new Error("phase must be one of: all, independent, candidate");
  }
  const group = options.rerunGroup ?? "all";
  let groups;
  if (group === "all") {
    groups = ["install-smoke", "cross-os", "package", "qa-parity"];
    if (isEnabled(options.runReleaseSoak)) {
      groups.push("live-e2e");
    }
    if (isEnabled(options.runReleaseSoak) || isEnabled(options.qaFilterSeen)) {
      groups.push("qa-live");
    }
  } else if (group === "qa") {
    groups = ["qa-parity", "qa-live"];
  } else if (
    ["install-smoke", "cross-os", "live-e2e", "package", "qa-parity", "qa-live"].includes(group)
  ) {
    groups = [group];
  } else {
    throw new Error("invalid release-check rerun group");
  }
  const selected = (name) => groups.includes(name);
  const independent = phase !== "candidate";
  const candidate = phase !== "independent";
  const result = {
    release_check_groups_json: JSON.stringify(groups),
    install_smoke_scheduled: independent && selected("install-smoke"),
    cross_os_scheduled: candidate && selected("cross-os"),
    live_e2e_scheduled: independent && selected("live-e2e"),
    package_acceptance_scheduled: candidate && selected("package"),
    qa_parity_scheduled: independent && selected("qa-parity"),
    qa_live_scheduled: independent && selected("qa-live"),
    docker_required: candidate && selected("live-e2e") && isBlank(options.repoLiveSuiteFilter),
  };
  return {
    ...result,
    package_acceptance_lanes: RELEASE_PACKAGE_ACCEPTANCE_LANES,
    package_required:
      result.cross_os_scheduled || result.package_acceptance_scheduled || result.docker_required,
  };
}

/** Package Acceptance's existing profile inventory; Telegram validation stays here too. */
export function createPackageAcceptanceSelection(options = {}) {
  const profile = options.suiteProfile ?? "package";
  let lanes = "";
  let releasePath = false;
  let openwebui = false;
  let scenarios = options.telegramScenarios ?? "";
  const telegramMode = options.telegramMode ?? "none";
  switch (profile) {
    case "smoke":
      lanes = "npm-onboard-channel-agent gateway-network config-reload";
      break;
    case "package":
      lanes =
        "npm-onboard-channel-agent doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor update-first-hop-compat published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update";
      break;
    case "product":
      lanes =
        "npm-onboard-channel-agent doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor update-first-hop-compat published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins plugin-update mcp-channels cron-mcp-cleanup openai-web-search-minimal openwebui";
      openwebui = true;
      break;
    case "full":
      releasePath = true;
      openwebui = true;
      break;
    case "custom":
      lanes = options.dockerLanes ?? "";
      if (isBlank(lanes)) {
        throw new Error("docker_lanes is required when suite_profile=custom.");
      }
      openwebui = lanes.includes("openwebui");
      break;
    case "telegram": {
      if (telegramMode === "none") {
        throw new Error("telegram_mode must not be none when suite_profile=telegram.");
      }
      const selected = scenarios
        .split(/[,\n]/u)
        .map((value) => value.trim())
        .filter(Boolean);
      if (selected.length !== 1) {
        throw new Error(
          "telegram_scenarios must contain exactly one scenario when suite_profile=telegram.",
        );
      }
      scenarios = selected[0];
      break;
    }
    default:
      throw new Error(`Unknown suite_profile: ${profile}`);
  }
  return {
    docker_lanes: lanes,
    include_release_path_suites: releasePath,
    include_openwebui: openwebui,
    include_live_suites: false,
    telegram_enabled: telegramMode !== "none",
    telegram_mode: telegramMode,
    telegram_scenarios: scenarios,
  };
}

/** Source-contract selections use the same chunks, aliases and baseline grouping as execution. */
export function createReleaseSourceSelection(options = {}) {
  const matrices = createReleaseWorkflowMatrixPlan(options);
  const releaseProfile = options.releaseProfile ?? "stable";
  const includeOpenWebUI = isEnabled(options.includeOpenWebUI);
  const prepareOnly = isEnabled(options.prepareOnly);
  const consumers = [];
  const codexSuites = [];
  const docker = [];
  const baseline = options.upgradeSurvivorBaseline ?? "";
  const baselines = options.upgradeSurvivorBaselines ?? "";
  const scenarios = options.upgradeSurvivorScenarios ?? "";
  const preparationLanes = prepareOnly
    ? [
        ...new Set([
          ...allReleasePathLanes({ releaseProfile, includeOpenWebUI }).map(({ name }) => name),
          ...createPluginPrereleaseTestPlan().dockerLanes,
        ]),
      ]
    : [];
  if (!prepareOnly) {
    for (const row of matrices.dockerE2e.matrix.include) {
      docker.push({
        profile: "release-path",
        releaseProfile,
        chunk: row.chunk_id,
        includeOpenWebUI,
        baselines,
        scenarios,
      });
    }
    if (!isBlank(options.dockerLanes)) {
      const groups = planTargetedDockerLaneGroups({
        lanes: options.dockerLanes,
        groupSize: options.targetedDockerLaneGroupSize ?? 1,
        upgradeSurvivorBaseline: baseline,
        upgradeSurvivorBaselines: baselines,
        upgradeSurvivorBaselineScope: options.upgradeSurvivorBaselineScope ?? "all-scenarios",
        upgradeSurvivorScenarios: scenarios,
      });
      for (const group of groups) {
        docker.push({
          lanes: parseLaneSelection(group.docker_lanes),
          releaseProfile,
          includeOpenWebUI,
          baselines: group.published_upgrade_survivor_baselines ?? baselines,
          scenarios: group.published_upgrade_survivor_scenarios ?? scenarios,
        });
      }
    }
    if (
      includeOpenWebUI &&
      isBlank(options.dockerLanes) &&
      ["stable", "full"].includes(releaseProfile)
    ) {
      docker.push({ lanes: ["openwebui"], releaseProfile, includeOpenWebUI });
    }
    for (const row of matrices.liveDocker.matrix.include) {
      if (row.suite_id.startsWith("live-codex-harness")) {
        codexSuites.push(row.suite_id);
      }
      if (row.suite_id.startsWith("live-gateway-") || row.suite_id.startsWith("live-cli-")) {
        consumers.push("live-cli-backend");
      }
    }
  }
  return {
    docker,
    consumers: [...new Set(consumers)],
    codexSuites,
    fsSafeNative: prepareOnly || docker.length > 0,
    preparationLanes,
  };
}

function planProfileMatrix(entries, profile, enabled, disabledReason, labelForEntry) {
  const selected = enabled ? entries.filter((entry) => profileIncludes(entry, profile)) : [];
  const omitted = entries
    .filter((entry) => !selected.includes(entry))
    .map((entry) => ({
      id: labelForEntry(entry),
      label: entry.label ?? entry.provider_label ?? labelForEntry(entry),
      reason: enabled ? `requires one of: ${entry.profiles}` : disabledReason,
    }));

  return {
    count: selected.length,
    matrix: { include: selected },
    omitted,
  };
}

/**
 * Creates the Docker E2E/live model matrix plan for a release profile.
 */
export function createReleaseWorkflowMatrixPlan(options = {}) {
  const releaseProfile = options.releaseProfile ?? "stable";
  if (!["beta", "minimum", "stable", "full"].includes(releaseProfile)) {
    throw new Error("unknown release profile");
  }
  const execution = !isEnabled(options.prepareOnly);
  const dockerE2eEnabled =
    execution && isEnabled(options.includeReleasePathSuites) && isBlank(options.dockerLanes);
  const liveModelsEnabled =
    execution &&
    isEnabled(options.includeLiveSuites) &&
    isBlank(options.liveModelProviders) &&
    (isBlank(options.liveSuiteFilter) || options.liveSuiteFilter === "docker-live-models");
  const liveDockerEnabled =
    execution && isEnabled(options.includeLiveSuites) && !isEnabled(options.liveModelsOnly);
  const liveDocker = LIVE_DOCKER_SUITES.filter(
    (entry) =>
      liveDockerEnabled &&
      profileIncludes(entry, releaseProfile) &&
      (isBlank(options.liveSuiteFilter) ||
        options.liveSuiteFilter === entry.suite_id ||
        options.liveSuiteFilter === entry.suite_group),
  );

  return {
    liveDocker: { count: liveDocker.length, matrix: { include: liveDocker } },
    dockerE2e: planProfileMatrix(
      DOCKER_E2E_CHUNKS,
      releaseProfile,
      dockerE2eEnabled,
      "release-path Docker E2E chunks disabled by input selection",
      (entry) => entry.chunk_id,
    ),
    liveModels: planProfileMatrix(
      LIVE_MODEL_PROVIDERS,
      releaseProfile,
      liveModelsEnabled,
      "Docker live model matrix disabled by input selection",
      (entry) => entry.providers,
    ),
    releaseProfile,
  };
}

function markdownForPlan(plan) {
  const sections = [
    ["Docker E2E release chunks", plan.dockerE2e],
    ["Docker live model providers", plan.liveModels],
  ];
  const lines = [
    `## Release workflow matrix plan`,
    "",
    `Release profile: \`${plan.releaseProfile}\``,
  ];

  for (const [title, section] of sections) {
    lines.push("", `### ${title}`, "", `Selected lanes: ${section.count}`);
    if (section.omitted.length === 0) {
      lines.push("", "No lanes omitted.");
      continue;
    }
    lines.push("", "| Omitted lane | Reason |", "| --- | --- |");
    for (const omitted of section.omitted) {
      lines.push(`| \`${omitted.id}\` | ${omitted.reason} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeOutputs(plan) {
  const outputs = {
    live_docker_count: String(plan.liveDocker.count),
    live_docker_matrix: JSON.stringify(plan.liveDocker.matrix),
    docker_e2e_count: String(plan.dockerE2e.count),
    docker_e2e_matrix: JSON.stringify(plan.dockerE2e.matrix),
    docker_e2e_omitted_json: JSON.stringify(plan.dockerE2e.omitted),
    live_models_count: String(plan.liveModels.count),
    live_models_matrix: JSON.stringify(plan.liveModels.matrix),
    live_models_omitted_json: JSON.stringify(plan.liveModels.omitted),
  };

  for (const [key, value] of Object.entries(outputs)) {
    console.log(`${key}=${value}`);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const plan = createReleaseWorkflowMatrixPlan({
    dockerLanes: process.env.DOCKER_LANES,
    includeLiveSuites: process.env.INCLUDE_LIVE_SUITES,
    includeReleasePathSuites: process.env.INCLUDE_RELEASE_PATH_SUITES,
    liveModelProviders: process.env.LIVE_MODEL_PROVIDERS,
    liveSuiteFilter: process.env.LIVE_SUITE_FILTER,
    liveModelsOnly: process.env.LIVE_MODELS_ONLY,
    prepareOnly: process.env.PREPARE_ONLY,
    releaseProfile: process.env.RELEASE_TEST_PROFILE || undefined,
  });

  writeOutputs(plan);
  const summary = markdownForPlan(plan);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
