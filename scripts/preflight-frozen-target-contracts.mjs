#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const entryPath = "scripts/preflight-frozen-target-contracts.mjs";
const readerPath = "scripts/lib/frozen-target-source.mjs";
const toolingClosure = [
  entryPath,
  readerPath,
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/release-version.mjs",
  "scripts/lib/frozen-target-compat.sh",
  "scripts/resolve-frozen-codex-live-suite.mjs",
  "scripts/resolve-fs-safe-native-contract.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
  "scripts/windows-cmd-helpers.mjs",
  "package.json",
  "pnpm-lock.yaml",
];
const workflowToolingClosure = [
  "scripts/plan-release-workflow-matrix.mjs",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/plugin-prerelease-test-plan.mts",
  "scripts/plan-targeted-docker-lane-groups.mjs",
  "scripts/lib/numeric-options.mjs",
];
const maxRecordBytes = 256 * 1024;
const prefix = "OPENCLAW_FROZEN_TARGET_";
const shellOwners = {
  onboard: ["onboard_contract", [`${prefix}ONBOARD_CASES`]],
  "release-typed-onboarding": [
    "typed_onboarding_contract",
    [
      `${prefix}ONBOARD_SESSION_MEMORY_HOOK_MODE`,
      `${prefix}TYPED_ONBOARDING_SCENARIO_PATH`,
      `${prefix}TYPED_ONBOARDING_ASSERTIONS_PATH`,
      `${prefix}TYPED_ONBOARDING_MOCK_CONFIG_PATH`,
    ],
  ],
  "session-runtime-context": [
    "runtime_context_contract",
    [`${prefix}RUNTIME_CONTEXT_INPUT_MODE`, `${prefix}SESSION_REPAIR_MODE`],
  ],
  "mcp-code-mode-gateway": [
    "mcp_code_mode_contract",
    [`${prefix}MCP_MEMORY_CONFIG_MODE`, `${prefix}MCP_CODE_MODE_CATALOG_MODE`],
  ],
  "agent-bundle-mcp-tools": [
    "agent_bundle_mcp_contract",
    [`${prefix}AGENT_BUNDLE_MCP_MODE`, `${prefix}AGENT_BUNDLE_MCP_CLIENT_PATH`],
  ],
  "gateway-network": ["gateway_network_layout", [`${prefix}GATEWAY_NETWORK_LEGACY_LIB`]],
  plugins: [
    "plugin_harness_capabilities",
    [`${prefix}PLUGIN_UNINSTALL_MODE`, "OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT"],
  ],
  "live-cli-backend": ["live_cli_backend_package_mode", [`${prefix}LIVE_CLI_BACKEND_PACKAGE_MODE`]],
  "update-channel-switch": [
    "update_channel_dry_run_mode",
    [
      "OPENCLAW_UPDATE_CHANNEL_DRY_RUN_PACKAGE_COMPAT",
      "OPENCLAW_UPDATE_CHANNEL_DIRTY_BLOCK_EXIT_ZERO_COMPAT",
    ],
  ],
  "upgrade-survivor": [
    "upgrade_survivor_capabilities",
    ["OPENCLAW_FROZEN_UPGRADE_SURVIVOR_CLAWHUB_MODE"],
  ],
};

// These are the existing wrappers' generic resolver arguments, not new dialect rules.
const targetFiles = {
  "npm-onboard-channel-agent": [
    ["scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs"],
    ["scripts/e2e/lib/fixtures/mock-openai-config.mjs"],
  ],
  "codex-on-demand": [
    ["scripts/e2e/lib/codex-on-demand/assertions.mjs"],
    ["scripts/e2e/lib/codex-on-demand/doctor-checks.mjs", ""],
  ],
  "update-corrupt-plugin": [["scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh"]],
  "kitchen-sink-plugin": [["scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs"]],
};
const supportFiles = {
  "npm-onboard-channel-agent": [
    "agent-turn-output.mjs",
    "auth-profile-store-assertions.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
    "openclaw-state-paths.mjs",
    "fixtures/common.mjs",
  ],
  "codex-on-demand": [
    "auth-profile-store-assertions.mjs",
    "codex-install-utils.mjs",
    "codex-release-package-assertions.mjs",
    "openclaw-state-paths.mjs",
    "plugin-index-sqlite.mjs",
    "fixtures/common.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
  ],
  "kitchen-sink-plugin": [
    "env-limits.mjs",
    "openclaw-state-paths.mjs",
    "plugin-index-sqlite.mjs",
    "plugin-uninstall-assertions.mjs",
    "text-file-utils.mjs",
  ],
  "update-corrupt-plugin": [
    "plugins/fixtures.sh",
    "plugin-update/probe.mjs",
    "plugin-index-sqlite.mjs",
    "update-first-hop-package-fixtures.mjs",
    "release-scenarios/assertions.mjs",
    "agent-turn-output.mjs",
    "auth-profile-store-assertions.mjs",
    "fixtures/mock-openai-config.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
    "openclaw-state-paths.mjs",
    "plugin-uninstall-assertions.mjs",
    "release-assertion-files.mjs",
    "package-compat.mjs",
    "plugin-update/consent-scenario.mjs",
    "plugin-update/process-observer.mjs",
  ],
};

// Acquisition inputs only. Dialect decisions remain in the shared resolver owners.
const selectedMetadata = {
  onboard: ["src/config/zod-schema.ts"],
  "release-typed-onboarding": [
    "src/commands/onboard-hooks.ts",
    "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
    "scripts/e2e/lib/release-scenarios/assertions.mjs",
    "scripts/e2e/lib/fixtures/mock-openai-config.mjs",
  ],
  "session-runtime-context": [
    "src/state/openclaw-agent-db-session-migrations.ts",
    "src/commands/doctor-session-transcripts.ts",
    "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts",
  ],
  "mcp-code-mode-gateway": ["src/agents/memory-search.ts", "src/agents/code-mode-namespaces.ts"],
  "agent-bundle-mcp-tools": [
    "package.json",
    "scripts/e2e/agent-bundle-mcp-tools-docker-client.ts",
    "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
    "scripts/e2e/lib/temp-state-dir.ts",
    "src/agents/agent-bundle-mcp-manager-api.ts",
    "src/agents/agent-bundle-mcp-runtime.ts",
  ],
  "gateway-network": [
    "scripts/e2e/lib/gateway-network/client.mjs",
    "scripts/e2e/lib/gateway-network/client.mts",
  ],
  plugins: [
    "scripts/e2e/lib/plugins/assertions.mjs",
    "src/config/types.messages.ts",
    "src/config/types.plugins.ts",
    "src/plugin-sdk/session-store-runtime.ts",
    "src/plugins/uninstall-package-plan.ts",
  ],
  "live-cli-backend": ["scripts/print-cli-backend-live-metadata.ts"],
  "update-channel-switch": ["src/cli/update-cli/update-command.ts"],
  "upgrade-survivor": [
    "package.json",
    "src/infra/clawhub-install-trust.ts",
    "src/plugins/clawhub.ts",
    "scripts/e2e/lib/upgrade-survivor",
    "scripts/lib/npm-publish-plan.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/e2e/lib/plugin-index-sqlite.mjs",
    "scripts/e2e/lib/env-limits.mjs",
    "scripts/e2e/lib/text-file-utils.mjs",
  ],
};

function workflowRequest(env) {
  const serialized = env.ADMISSION_INPUTS ?? "{}";
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 48 * 1024) {
    throw new Error("invalid workflow inputs");
  }
  const raw = JSON.parse(serialized);
  if (
    !raw ||
    Array.isArray(raw) ||
    typeof raw !== "object" ||
    Object.values(raw).some((value) => !["string", "boolean", "number"].includes(typeof value))
  ) {
    throw new Error("invalid workflow inputs");
  }
  const get = (name, fallback = "") => raw[name] ?? fallback;
  const flag = (value) => value === true || value === "true";
  const profile =
    env.ADMISSION_RELEASE_PROFILE || get("release_test_profile", get("release_profile", "stable"));
  const options = {
    releaseProfile: profile === "minimum" ? "beta" : profile,
    phase: get("phase", "all"),
    rerunGroup: get("rerun_group", "all"),
    runReleaseSoak: flag(get("run_release_soak")) || profile === "stable" || profile === "full",
    qaFilterSeen: flag(env.ADMISSION_QA_FILTER_SEEN),
    liveSuiteFilter: env.ADMISSION_REPO_LIVE_SUITE_FILTER ?? get("live_suite_filter"),
    liveModelsOnly: flag(get("live_models_only")),
    liveModelProviders: get("live_model_providers"),
    includeLiveSuites: flag(get("include_live_suites", true)),
    includeReleasePathSuites: flag(get("include_release_path_suites", true)),
    includeOpenWebUI: flag(get("include_openwebui")),
    includeRepoE2e: flag(get("include_repo_e2e", true)),
    prepareOnly: flag(get("prepare_only")),
    dockerLanes: get("docker_lanes"),
    targetedDockerLaneGroupSize: String(get("targeted_docker_lane_group_size", 1)),
    suiteProfile: get("suite_profile", "package"),
    telegramMode: get("telegram_mode", "none"),
    telegramScenarios: get("telegram_scenarios"),
    upgradeSurvivorBaseline:
      env.ADMISSION_BASELINE ?? get("published_upgrade_survivor_baseline", "openclaw@latest"),
    upgradeSurvivorBaselines:
      env.ADMISSION_BASELINES ?? get("published_upgrade_survivor_baselines"),
    upgradeSurvivorBaselineScope:
      env.ADMISSION_BASELINE_SCOPE ??
      get("published_upgrade_survivor_baseline_scope", "all-scenarios"),
    upgradeSurvivorScenarios: get("published_upgrade_survivor_scenarios"),
    baselinesResolved: env.ADMISSION_BASELINES_RESOLVED === "true",
    packageOverride: Boolean(String(get("release_package_spec")).trim()),
    acceptanceOverride: Boolean(String(get("package_acceptance_package_spec")).trim()),
  };
  const workflow = env.ADMISSION_WORKFLOW;
  if (workflow === "parent") {
    options.upgradeSurvivorScenarios = options.runReleaseSoak ? "reported-issues" : "";
  }
  return {
    version: 2,
    repository: text(env.GITHUB_REPOSITORY, "repository"),
    selected: {
      root: text(env.ADMISSION_SELECTED_ROOT, "selected root"),
      sha: text(env.ADMISSION_SELECTED_SHA, "selected SHA"),
    },
    tooling: {
      root: text(env.ADMISSION_TOOLING_ROOT, "tooling root"),
      sha: text(env.ADMISSION_TOOLING_SHA, "tooling SHA"),
    },
    allowFrozenTargetScenarioOmissions:
      flag(get("allow_frozen_target_scenario_omissions")) ||
      (workflow === "parent" && Boolean(get("target_context_ref"))),
    workflow,
    options,
    requestedBaselines: {
      baseline: get("published_upgrade_survivor_baseline", "openclaw@latest"),
      baselines: get("published_upgrade_survivor_baselines"),
      scope: get("published_upgrade_survivor_baseline_scope", "all-scenarios"),
      scenarios: options.upgradeSurvivorScenarios,
    },
    binding: {
      workflowRef: text(env.ADMISSION_WORKFLOW_REF, "workflow ref"),
      inputsDigest: createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.keys(raw)
                .toSorted()
                .map((key) => [key, raw[key]]),
            ),
          ),
        )
        .digest("hex"),
      coveragePolicy: text(env.ADMISSION_COVERAGE_POLICY ?? "", "coverage policy"),
      candidateRequestDigest: text(
        env.ADMISSION_CANDIDATE_REQUEST_DIGEST ?? "",
        "candidate request digest",
      ),
      packageSourceSha: text(env.ADMISSION_PACKAGE_SOURCE_SHA ?? "", "package source SHA"),
      packageSha256: text(env.ADMISSION_PACKAGE_SHA256 ?? "", "package digest"),
      packageVersion: text(env.ADMISSION_PACKAGE_VERSION ?? "", "package version"),
      stage: text(env.ADMISSION_STAGE ?? "source", "admission stage"),
    },
    provenance: {
      runId: text(env.GITHUB_RUN_ID, "run id"),
      runAttempt: text(env.GITHUB_RUN_ATTEMPT, "run attempt"),
    },
  };
}

async function planWorkflowAdmission(input) {
  object(
    input,
    [
      "version",
      "repository",
      "selected",
      "tooling",
      "allowFrozenTargetScenarioOmissions",
      "workflow",
      "options",
      "requestedBaselines",
      "binding",
      "provenance",
    ],
    "workflow admission",
  );
  if (
    input.version !== 2 ||
    input.repository !== "openclaw/openclaw" ||
    !["parent", "release-checks", "reusable", "package"].includes(input.workflow)
  ) {
    throw new Error("invalid workflow admission identity");
  }
  for (const key of ["selected", "tooling"]) {
    object(input[key], ["root", "sha"], `${key} identity`);
    text(input[key].root, `${key} root`);
    if (!/^[a-f0-9]{40}$/u.test(input[key].sha)) {
      throw new Error(`missing exact ${key} source SHA`);
    }
  }
  const allow = boolean(input.allowFrozenTargetScenarioOmissions);
  const options = object(
    input.options,
    [
      "releaseProfile",
      "phase",
      "rerunGroup",
      "runReleaseSoak",
      "qaFilterSeen",
      "liveSuiteFilter",
      "liveModelsOnly",
      "liveModelProviders",
      "includeLiveSuites",
      "includeReleasePathSuites",
      "includeOpenWebUI",
      "includeRepoE2e",
      "prepareOnly",
      "dockerLanes",
      "targetedDockerLaneGroupSize",
      "suiteProfile",
      "telegramMode",
      "telegramScenarios",
      "upgradeSurvivorBaseline",
      "upgradeSurvivorBaselines",
      "upgradeSurvivorBaselineScope",
      "upgradeSurvivorScenarios",
      "baselinesResolved",
      "packageOverride",
      "acceptanceOverride",
    ],
    "workflow selection",
  );
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string") {
      if (
        [
          "dockerLanes",
          "liveModelProviders",
          "telegramScenarios",
          "upgradeSurvivorBaselines",
          "upgradeSurvivorScenarios",
        ].includes(key)
      ) {
        tokenListText(value, "selection value");
      } else {
        text(value, "selection value");
      }
    } else {
      boolean(value);
    }
  }
  object(
    input.binding,
    [
      "workflowRef",
      "inputsDigest",
      "coveragePolicy",
      "candidateRequestDigest",
      "packageSourceSha",
      "packageSha256",
      "packageVersion",
      "stage",
    ],
    "workflow binding",
  );
  for (const value of Object.values(input.binding)) {
    text(value, "binding");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(input.binding.inputsDigest) ||
    !input.binding.workflowRef?.startsWith(`openclaw/openclaw/.github/workflows/`)
  ) {
    throw new Error("missing workflow input binding");
  }
  if (
    input.workflow === "package" &&
    input.binding.stage !== "known-source" &&
    (!/^[a-f0-9]{40}$/u.test(input.binding.packageSourceSha) ||
      !/^[a-f0-9]{64}$/u.test(input.binding.packageSha256) ||
      !input.binding.packageVersion?.trim())
  ) {
    throw new Error("complete resolved package identity is required");
  }
  object(input.provenance, ["runId", "runAttempt"], "attempt provenance");
  if (
    !/^[1-9][0-9]*$/u.test(input.provenance.runId) ||
    !/^[1-9][0-9]*$/u.test(input.provenance.runAttempt)
  ) {
    throw new Error("invalid run attempt provenance");
  }
  if (input.binding.packageSourceSha && input.binding.packageSourceSha !== input.selected.sha) {
    throw new Error("package source differs from selected source");
  }
  const obligations = [];
  const requestedBaselines = object(
    input.requestedBaselines,
    ["baseline", "baselines", "scope", "scenarios"],
    "requested baselines",
  );
  for (const [key, value] of Object.entries(requestedBaselines)) {
    if (key === "baselines" || key === "scenarios") {
      tokenListText(value, "requested baseline");
    } else {
      text(value, "requested baseline");
    }
  }
  // Planning precedes selected-object acquisition; only tooling is read here.
  await loadVerifiedTooling(input.tooling, true);
  const {
    createPackageAcceptanceSelection,
    createReleaseCheckSelection,
    createReleaseSourceSelection,
    RELEASE_PACKAGE_ACCEPTANCE_LANES,
  } = await import("./plan-release-workflow-matrix.mjs");
  const { releasePathChunkLanes } = await import("./lib/docker-e2e-scenarios.mts");
  const { createPluginPrereleaseTestPlan } = await import("./lib/plugin-prerelease-test-plan.mts");
  const { parseUpgradeSurvivorScenarios } = await import("./lib/upgrade-survivor-policy.mjs");
  const baselineOptions = options.baselinesResolved
    ? options
    : {
        ...options,
        upgradeSurvivorBaseline: "",
        upgradeSurvivorBaselines: "",
        upgradeSurvivorBaselineScope: "all-scenarios",
      };
  const selections = [];
  const add = (overrides) =>
    selections.push(createReleaseSourceSelection({ ...baselineOptions, ...overrides }));
  if (input.workflow === "reusable") {
    add({});
  } else if (input.workflow === "package") {
    const profile = createPackageAcceptanceSelection(options);
    add({
      dockerLanes: profile.docker_lanes,
      includeOpenWebUI: profile.include_openwebui,
      includeReleasePathSuites: profile.include_release_path_suites,
      includeLiveSuites: false,
    });
  } else {
    const releaseGroups = [
      "all",
      "install-smoke",
      "cross-os",
      "live-e2e",
      "package",
      "qa",
      "qa-parity",
      "qa-live",
    ];
    if (releaseGroups.includes(options.rerunGroup)) {
      const groups = createReleaseCheckSelection({
        ...options,
        repoLiveSuiteFilter: options.liveSuiteFilter,
        phase: input.workflow === "parent" ? "all" : options.phase,
      });
      if (groups.live_e2e_scheduled) {
        add({
          includeLiveSuites: true,
          includeReleasePathSuites: false,
          includeOpenWebUI: false,
          dockerLanes: "",
        });
      }
      if (groups.docker_required && !options.packageOverride) {
        add({
          includeLiveSuites: false,
          includeReleasePathSuites: true,
          includeOpenWebUI: options.releaseProfile !== "beta",
          dockerLanes: "",
        });
      }
      if (
        groups.package_acceptance_scheduled &&
        !options.packageOverride &&
        !options.acceptanceOverride
      ) {
        add({
          includeLiveSuites: false,
          includeReleasePathSuites: false,
          includeOpenWebUI: false,
          dockerLanes: RELEASE_PACKAGE_ACCEPTANCE_LANES,
        });
      }
      if (groups.package_required && (options.packageOverride || options.acceptanceOverride)) {
        obligations.push({ kind: "package-source", status: "UNRESOLVED" });
      }
    }
    if (input.workflow === "parent" && ["all", "plugin-prerelease"].includes(options.rerunGroup)) {
      add({
        includeLiveSuites: false,
        includeReleasePathSuites: false,
        includeOpenWebUI: false,
        dockerLanes: createPluginPrereleaseTestPlan().dockerLanes.join(" "),
      });
    }
  }
  const docker = selections.flatMap((selection) => selection.docker);
  const explicitConsumers = [...new Set(selections.flatMap((selection) => selection.consumers))];
  const consumers = new Set(explicitConsumers);
  const codexSuites = [...new Set(selections.flatMap((selection) => selection.codexSuites))];
  const possibleLanes = [];
  let mobilePairingSelected = false;
  for (const selection of docker) {
    const lanes =
      selection.lanes ??
      releasePathChunkLanes(selection.chunk, {
        releaseProfile: selection.releaseProfile,
        includeOpenWebUI: selection.includeOpenWebUI,
      }).map(({ name }) => name);
    possibleLanes.push(...lanes);
    const survivorLanes = lanes.filter((lane) =>
      /^(published-upgrade-survivor|update-migration)(-|$)/u.test(lane),
    );
    if (
      allow &&
      survivorLanes.length &&
      (survivorLanes.some((lane) => lane.includes("mobile-pairing-reconnect")) ||
        parseUpgradeSurvivorScenarios(selection.scenarios ?? "").includes(
          "mobile-pairing-reconnect",
        ))
    ) {
      mobilePairingSelected = true;
    }
  }
  for (const name of possibleLanes) {
    const consumer = consumerForLane(name);
    if (consumer) {
      consumers.add(consumer);
    }
  }
  if (
    possibleLanes.some(
      (lane) =>
        lane === "root-managed-vps-upgrade" ||
        lane === "update-restart-auth" ||
        /^(published-upgrade-survivor|update-migration)(-|$)/u.test(lane),
    )
  ) {
    if (!options.baselinesResolved) {
      obligations.push({
        kind: "upgrade-baselines",
        status: "UNRESOLVED",
        requested: requestedBaselines,
      });
    } else {
      const { normalizeUpgradeSurvivorBaselineSpec, parseUpgradeSurvivorBaselineSpecs } =
        await import("./lib/upgrade-survivor-policy.mjs");
      const specs = [
        normalizeUpgradeSurvivorBaselineSpec(options.upgradeSurvivorBaseline),
        ...parseUpgradeSurvivorBaselineSpecs(options.upgradeSurvivorBaselines),
      ];
      if (!specs[0] || specs.some((spec) => !/^openclaw@[0-9]/u.test(spec))) {
        throw new Error("unresolved upgrade baselines at the execution boundary");
      }
    }
  }
  const sourcePaths = new Set();
  if (allow) {
    for (const consumer of consumers) {
      for (const path of selectedMetadata[
        consumer === "kitchen-sink-plugin" ? "plugins" : consumer
      ] ?? []) {
        sourcePaths.add(path);
      }
      for (const [path] of targetFiles[consumer] ?? []) {
        sourcePaths.add(path);
      }
    }
    if (codexSuites.length) {
      sourcePaths.add("extensions/codex/provider-catalog.ts");
      sourcePaths.add("scripts/test-live-codex-harness-docker.sh");
    }
  }
  if (consumers.has("codex-on-demand")) {
    sourcePaths.add("extensions/codex/package.json");
  }
  const fsSafeNative = selections.some((selection) => selection.fsSafeNative);
  if (fsSafeNative && allow) {
    sourcePaths.add("package.json");
    sourcePaths.add("src/infra/fs-safe-defaults.ts");
  }
  for (const [lane, path] of [
    ["update-first-hop-compat", "scripts/runtime-postbuild.mts"],
    ["update-corrupt-plugin", "src/cli/update-cli/update-command-plugin-preflight.ts"],
  ]) {
    if (possibleLanes.includes(lane)) {
      sourcePaths.add(path);
    }
  }
  if (mobilePairingSelected) {
    sourcePaths.add("src/gateway/node-command-policy.ts");
  }
  if (
    possibleLanes.some((lane) => /^(published-upgrade-survivor|update-migration)(-|$)/u.test(lane))
  ) {
    sourcePaths.add("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
  }
  if (docker.length > 256) {
    throw new Error("too many selected Docker groups");
  }
  return {
    docker,
    consumers: [...consumers].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    explicitConsumers,
    codexSuites,
    fsSafeNative,
    preparationLanes: [...new Set(selections.flatMap((selection) => selection.preparationLanes))],
    sourcePaths: [...sourcePaths].toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    sourceHistory: fsSafeNative && allow,
    parserRequired: allow && consumers.has("agent-bundle-mcp-tools"),
    obligations,
    requestedBaselines,
  };
}

async function preflightWorkflow(input) {
  const plan = await planWorkflowAdmission(input);
  if (
    (input.workflow === "reusable" || input.binding.stage === "resolved-package") &&
    plan.obligations.some((obligation) => obligation.kind === "upgrade-baselines")
  ) {
    throw new Error("unresolved upgrade baselines at the execution boundary");
  }
  const common = {
    version: 1,
    repository: input.repository,
    selected: input.selected,
    tooling: input.tooling,
    allowFrozenTargetScenarioOmissions: input.allowFrozenTargetScenarioOmissions,
  };
  const verified = await loadVerifiedTooling(input.tooling, true);
  // Share verified evidence, not the reader's deadline or cumulative read set.
  const verifiedTooling = {
    sha: input.tooling.sha,
    createFrozenTargetSource: verified.createFrozenTargetSource,
    identities: Object.freeze(verified.source.blobIdentities().map(Object.freeze)),
  };
  // Evaluate each baseline/scenario group without collapsing the execution owner's pairing.
  const evaluations = [];
  for (const docker of plan.docker) {
    evaluations.push(
      await preflightFrozenTargetContracts(
        { ...common, selection: { docker } },
        true,
        verifiedTooling,
      ),
    );
  }
  evaluations.push(
    await preflightFrozenTargetContracts(
      {
        ...common,
        selection: {
          consumers: plan.explicitConsumers,
          codexSuites: plan.codexSuites,
          fsSafeNative: plan.fsSafeNative,
        },
      },
      true,
      verifiedTooling,
    ),
  );
  const executionStates = evaluations.flatMap((evaluation) => [
    ...(evaluation.docker ? [evaluation.docker.status] : []),
    ...evaluation.contracts
      .filter((contract) => contract.consumer !== "fs-safe-native")
      .map((contract) => contract.status),
  ]);
  const sources = { selected: [], tooling: [] };
  const identityIndexes = { selected: new Map(), tooling: new Map() };
  const compactEvaluations = evaluations.map((evaluation) => {
    const sourceRefs = {};
    for (const role of ["selected", "tooling"]) {
      sourceRefs[role] = evaluation.sources[role].map((identity) => {
        const key = JSON.stringify(identity);
        if (!identityIndexes[role].has(key)) {
          identityIndexes[role].set(key, sources[role].length);
          sources[role].push(identity);
        }
        return identityIndexes[role].get(key);
      });
    }
    return Object.assign(
      {
        selection: evaluation.selection,
        contracts: evaluation.contracts,
      },
      evaluation.docker ? { docker: evaluation.docker } : {},
      { sourceRefs, digest: evaluation.digest },
    );
  });
  const content = {
    version: 2,
    repository: input.repository,
    selectedSha: input.selected.sha,
    toolingSha: input.tooling.sha,
    workflow: input.workflow,
    binding: input.binding,
    options: input.options,
    requestedBaselines: plan.requestedBaselines,
    obligations: plan.obligations,
    preparationLanes: plan.preparationLanes,
    evaluationIdentity: {
      version: 1,
      repository: input.repository,
      selectedSha: input.selected.sha,
      toolingSha: input.tooling.sha,
    },
    sources,
    evaluations: compactEvaluations,
    status: plan.obligations.length
      ? "UNRESOLVED"
      : executionStates.includes("ADMITTED")
        ? "ADMITTED"
        : executionStates.length
          ? "NOT RUN"
          : plan.preparationLanes.length
            ? "PREPARATION ONLY"
            : "UNSELECTED",
  };
  const bytes = JSON.stringify(content);
  const record = {
    ...content,
    digest: createHash("sha256").update(bytes).digest("hex"),
    provenance: input.provenance,
  };
  if (Buffer.byteLength(`${JSON.stringify(record)}\n`) > maxRecordBytes) {
    throw new Error("workflow admission record exceeds limit");
  }
  return record;
}

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function text(value, label, limit = 4096) {
  if (typeof value !== "string" || value.length > limit) {
    throw new Error(`invalid ${label}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) {
      throw new Error(`invalid ${label}`);
    }
  }
  return value;
}

function tokenListText(value, label) {
  if (typeof value !== "string") {
    throw new Error(`invalid ${label}`);
  }
  // Preserve list whitespace for the owning parser without admitting other controls.
  text(value.replace(/[\t\r\n]/gu, " "), label);
  return value;
}

function strings(value, label) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`invalid ${label}`);
  }
  return [...new Set(value.map((entry) => text(entry, label, 256)))].toSorted();
}

function boolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("expected boolean selection");
  }
  return value;
}

function required(source, path) {
  const content = source.readText(path);
  if (content === null) {
    throw new Error(`missing required contract file: ${path}`);
  }
  return content;
}

function verifyToolingFile(path, committed) {
  const file = join(ownRoot, path);
  let info;
  try {
    info = lstatSync(file);
    if (!info.isFile() || realpathSync.native(file) !== file) {
      throw new Error("not an owned regular file");
    }
  } catch {
    throw new Error(`tooling closure requires an owned regular file: ${path}`);
  }
  if (info.size !== committed.length || !readFileSync(file).equals(committed)) {
    throw new Error(`tooling closure does not match committed source: ${path}`);
  }
}

function verifyReaderBootstrap(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("tooling source requires a full lowercase commit SHA");
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const deadline = Date.now() + 30_000;
  const git = (...args) => {
    try {
      const timeout = deadline - Date.now();
      if (timeout <= 0) {
        throw new Error("bootstrap read limit exceeded");
      }
      // Unsupported no-lazy-fetch flags fail closed before the reader can load.
      return execFileSync(
        "git",
        ["--no-lazy-fetch", "--no-replace-objects", "-C", ownRoot, ...args],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
    } catch {
      throw new Error("unable to read committed tooling bootstrap");
    }
  };
  // The launched bootstrap and checkout are trusted; this binds their working
  // bytes, not hostile bootstrap code or concurrent writers. The verified reader
  // still owns Git version, HEAD, commit/tree hashes, and all other source reads.
  for (const path of [entryPath, readerPath]) {
    const entry = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(
      git("ls-tree", "-z", sha, "--", path).toString("utf8"),
    );
    if (!entry || entry[3] !== path) {
      throw new Error(`tooling bootstrap requires a regular committed file: ${path}`);
    }
    const content = git("cat-file", "blob", entry[2]);
    const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (oid !== entry[2]) {
      throw new Error("unable to read committed tooling bootstrap (object hash mismatch)");
    }
    verifyToolingFile(path, content);
  }
}

async function loadVerifiedTooling(identity, workflow = false) {
  object(identity, ["root", "sha"], "tooling identity");
  if (realpathSync(text(identity.root, "tooling root")) !== ownRoot) {
    throw new Error("tooling identity does not own this evaluator");
  }
  verifyReaderBootstrap(identity.sha);
  const { createFrozenTargetSource } = await import("./lib/frozen-target-source.mjs");
  const source = createFrozenTargetSource(ownRoot, identity.sha);
  const recipes = source.readDirectory("scripts/e2e/lib/upgrade-survivor/config-recipe");
  if (recipes === null) {
    throw new Error("missing required tooling recipe directory");
  }
  for (const path of [...toolingClosure, ...(workflow ? workflowToolingClosure : []), ...recipes]) {
    verifyToolingFile(path, Buffer.from(required(source, path), "utf8"));
  }
  return { source, createFrozenTargetSource };
}

function consumerForLane(name) {
  if (
    name === "root-managed-vps-upgrade" ||
    name === "update-restart-auth" ||
    /^(published-upgrade-survivor|update-migration)(-|$)/u.test(name)
  ) {
    return "upgrade-survivor";
  }
  if (name.startsWith("npm-onboard-")) {
    return "npm-onboard-channel-agent";
  }
  if (name === "live-mcp-code-mode-gateway") {
    return "mcp-code-mode-gateway";
  }
  if (name === "live-gateway") {
    return "live-cli-backend";
  }
  if (
    name === "plugins-offline" ||
    name === "mcp-channels" ||
    name === "kitchen-sink-rpc" ||
    /^bundled-plugin-install-uninstall(-|$)/u.test(name)
  ) {
    return "plugins";
  }
  return Object.hasOwn(shellOwners, name) || Object.hasOwn(targetFiles, name) ? name : null;
}

async function preflightFrozenTargetContracts(input, workflow = false, verifiedTooling = null) {
  object(
    input,
    [
      "version",
      "repository",
      "selected",
      "tooling",
      "allowFrozenTargetScenarioOmissions",
      "selection",
    ],
    "admission request",
  );
  if (input.version !== 1 || input.repository !== "openclaw/openclaw") {
    throw new Error("invalid admission identity");
  }
  const allow = boolean(input.allowFrozenTargetScenarioOmissions);
  object(input.selected, ["root", "sha"], "selected identity");
  const roots = {
    selected: realpathSync(text(input.selected.root, "selected root")),
    tooling: ownRoot,
  };
  if (verifiedTooling) {
    object(input.tooling, ["root", "sha"], "tooling identity");
    if (
      realpathSync(text(input.tooling.root, "tooling root")) !== ownRoot ||
      input.tooling.sha !== verifiedTooling.sha
    ) {
      throw new Error("verified tooling identity differs from evaluation");
    }
  }
  const { source, createFrozenTargetSource } = verifiedTooling
    ? {
        source: verifiedTooling.createFrozenTargetSource(ownRoot, input.tooling.sha),
        createFrozenTargetSource: verifiedTooling.createFrozenTargetSource,
      }
    : await loadVerifiedTooling(input.tooling, workflow);
  const sources = {
    tooling: source,
    selected: createFrozenTargetSource(roots.selected, input.selected.sha),
  };
  const {
    DEFAULT_LIVE_RETRIES,
    parseLaneSelection,
    parseLiveMode,
    parseProfile,
    resolveDockerE2ePlan,
  } = await import("./lib/docker-e2e-plan.mts");
  const { classifyReleaseTrain, parseReleaseVersion } = await import("./lib/release-version.mjs");
  const { resolveFrozenCodexCompatibility } = await import("./resolve-frozen-codex-live-suite.mjs");
  const { resolveFsSafeNativeContract } = await import("./resolve-fs-safe-native-contract.mjs");
  if (allow && input.selected.sha === input.tooling.sha) {
    throw new Error("frozen omissions require distinct identities");
  }
  const selection = object(
    input.selection,
    ["docker", "consumers", "codexSuites", "fsSafeNative"],
    "selection",
  );
  const consumers = new Set(strings(selection.consumers ?? [], "consumers"));
  for (const consumer of consumers) {
    if (!Object.hasOwn(shellOwners, consumer) && !Object.hasOwn(targetFiles, consumer)) {
      throw new Error(`unknown selected contract: ${consumer}`);
    }
  }
  const codexSuites = strings(selection.codexSuites ?? [], "Codex suites");
  if (
    codexSuites.some(
      (suite) => !/^live-codex-harness(?:-gpt56-(?:sol|luna|terra))?-docker$/u.test(suite),
    )
  ) {
    throw new Error("unknown selected Codex suite");
  }
  const fsSafeNative = boolean(selection.fsSafeNative);
  let docker;
  let normalizedDocker;
  if (selection.docker !== undefined) {
    const value = object(
      selection.docker,
      [
        "lanes",
        "profile",
        "releaseProfile",
        "chunk",
        "planReleaseAll",
        "liveMode",
        "includeOpenWebUI",
        "baselines",
        "scenarios",
      ],
      "Docker selection",
    );
    normalizedDocker = {
      lanes: parseLaneSelection(strings(value.lanes ?? [], "Docker lanes").join(",")),
      profile: parseProfile(text(value.profile ?? "all", "Docker profile")),
      releaseProfile: text(value.releaseProfile ?? "full", "release profile"),
      chunk: text(value.chunk ?? "core", "release chunk"),
      planReleaseAll: boolean(value.planReleaseAll),
      liveMode: parseLiveMode(text(value.liveMode ?? "all", "live mode")),
      includeOpenWebUI: boolean(value.includeOpenWebUI),
      baselines: tokenListText(value.baselines ?? "", "baselines"),
      scenarios: tokenListText(value.scenarios ?? "", "scenarios"),
    };
    const result = resolveDockerE2ePlan({
      allowFrozenTargetScenarioOmissions: allow,
      frozenTarget: { mode: "inert", source: sources.selected },
      includeOpenWebUI: normalizedDocker.includeOpenWebUI,
      liveMode: normalizedDocker.liveMode,
      liveRetries: DEFAULT_LIVE_RETRIES,
      orderLanes: (lanes) => lanes,
      planReleaseAll: normalizedDocker.planReleaseAll,
      profile: normalizedDocker.profile,
      releaseChunk: normalizedDocker.chunk,
      releaseProfile: normalizedDocker.releaseProfile,
      selectedLaneNames: normalizedDocker.lanes,
      upgradeSurvivorBaselines: normalizedDocker.baselines,
      upgradeSurvivorScenarios: normalizedDocker.scenarios,
    });
    docker = {
      lanes: result.scheduledLanes.map((lane) => lane.name),
      omitted: result.omittedUnsupportedLaneNames,
      status: result.scheduledLanes.length ? "ADMITTED" : "NOT RUN",
    };
    for (const lane of docker.lanes) {
      const consumer = consumerForLane(lane);
      if (consumer) {
        consumers.add(consumer);
      }
    }
  }
  const env = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: allow ? "1" : "0",
    OPENCLAW_SELECTED_SHA: input.selected.sha,
    OPENCLAW_TOOLING_SHA: input.tooling.sha,
  };
  const deadline = Date.now() + 60_000;
  const shell = (command, args) =>
    execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -euo pipefail; source "$1"; shift; ${command}`,
        "admission",
        join(roots.tooling, "scripts/lib/frozen-target-compat.sh"),
        ...args,
      ],
      {
        cwd: roots.tooling,
        env,
        encoding: "utf8",
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: maxRecordBytes,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const rootOrder = ["tooling", "selected"].toSorted((a, b) => roots[b].length - roots[a].length);
  const bindPath = (absolute) => {
    if (!absolute) {
      return null;
    }
    for (const key of rootOrder) {
      const path = relative(roots[key], absolute);
      if (!path.startsWith("../") && path !== ".." && !path.startsWith("/")) {
        required(sources[key], path);
        return { source: key, path };
      }
    }
    throw new Error("resolved contract path escaped its source");
  };
  const contracts = [];
  for (const consumer of [...consumers].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const contract = { consumer, status: "ADMITTED", modes: {}, files: [] };
    const owner = shellOwners[consumer === "kitchen-sink-plugin" ? "plugins" : consumer];
    if (owner) {
      const [fn, names] = owner;
      const output = shell(
        `openclaw_resolve_frozen_${fn} "$1" "$2"; shift 2; for key in "$@"; do printf "%s\\0" "\${!key}"; done`,
        [roots.selected, roots.tooling, ...names],
      ).split("\0");
      if (output.pop() !== "" || output.length !== names.length) {
        throw new Error("invalid contract result");
      }
      for (const [index, name] of names.entries()) {
        const value = output[index];
        if (name.endsWith("_PATH")) {
          const absolute = name.endsWith("_CLIENT_PATH")
            ? join(allow ? roots.selected : roots.tooling, value)
            : value;
          contract.files.push(bindPath(absolute));
        } else if (name.endsWith("_LIB")) {
          if (value) {
            const path = relative(roots.selected, value);
            required(sources.selected, `${path}/gateway-network/client.mjs`);
            contract.modes[name] = path;
          }
        } else {
          contract.modes[name] = text(value, "contract mode", 1024);
        }
      }
    }
    for (const [path, missing] of targetFiles[consumer] ?? []) {
      const args = [roots.selected, path, join(roots.tooling, path)];
      if (missing !== undefined) {
        args.push(missing);
      }
      const value = shell('openclaw_resolve_frozen_target_file "$@"', args).trimEnd();
      contract.files.push(bindPath(value));
    }
    if (consumer === "codex-on-demand") {
      const path = "extensions/codex/package.json";
      required(sources.selected, path);
      contract.files.push({ source: "selected", path });
    }
    for (const path of supportFiles[consumer] ?? []) {
      required(sources.tooling, `scripts/e2e/lib/${path}`);
    }
    if (
      ["npm-onboard-channel-agent", "codex-on-demand", "update-corrupt-plugin"].includes(consumer)
    ) {
      required(sources.tooling, "scripts/lib/record-shared.mjs");
    }
    if (consumer === "update-corrupt-plugin") {
      required(sources.tooling, "scripts/lib/update-compat-contract.mjs");
      required(sources.tooling, "scripts/lib/openclaw-e2e-instance.sh");
      required(sources.tooling, "scripts/lib/direct-run.mjs");
    }
    if (consumer === "upgrade-survivor" && allow) {
      const version = JSON.parse(required(sources.selected, "package.json")).version;
      const parsed = typeof version === "string" ? parseReleaseVersion(version) : null;
      if (!parsed) {
        throw new Error("selected upgrade target has an invalid release version");
      }
      const train = classifyReleaseTrain(parsed);
      if (train === "unsupported-extended-stable-correction") {
        throw new Error("unsupported extended-stable correction");
      }
      contract.modes.releaseTrain = train;
      if (train === "extended-stable") {
        const dir = "scripts/e2e/lib/upgrade-survivor";
        const selected = shell('openclaw_resolve_frozen_target_file "$@"', [
          roots.selected,
          dir,
        ]).trimEnd();
        if (!selected) {
          throw new Error("selected extended-stable target lacks its scenario");
        }
        for (const file of ["run.sh", "assertions.mjs", "probe-gateway.mjs"]) {
          required(sources.selected, `${dir}/${file}`);
        }
        const files = sources.selected.readDirectory(dir);
        const recipes = ["config-recipe.mjs", "config-recipe.mts"].filter((file) =>
          files.includes(`${dir}/${file}`),
        );
        if (recipes.length !== 1) {
          throw new Error("missing or ambiguous shipped survivor recipe");
        }
        const recipeFiles = sources.selected.readDirectory(`${dir}/config-recipe`);
        if (!recipeFiles?.length) {
          throw new Error("missing shipped survivor recipe data");
        }
        for (const section of [
          "agents",
          "channels-discord",
          "channels-feishu",
          "channels-matrix",
          "channels-telegram",
          "channels-whatsapp",
          "gateway",
          "models-openai",
          "plugins-configured-installs",
          "plugins-feishu",
          "plugins",
          "skills",
        ]) {
          required(sources.selected, `${dir}/config-recipe/${section}.json`);
        }
        for (const path of [
          "scripts/lib/npm-publish-plan.mjs",
          "scripts/windows-cmd-helpers.mjs",
          "scripts/e2e/lib/plugin-index-sqlite.mjs",
          "scripts/e2e/lib/env-limits.mjs",
          "scripts/e2e/lib/text-file-utils.mjs",
        ]) {
          const selectedFile = shell('openclaw_resolve_frozen_target_file "$@"', [
            roots.selected,
            path,
          ]).trimEnd();
          if (!selectedFile) {
            throw new Error(`missing shipped survivor support: ${path}`);
          }
          contract.files.push(bindPath(selectedFile));
        }
      }
    }
    contracts.push(contract);
  }
  for (const suiteId of codexSuites) {
    const result = allow
      ? resolveFrozenCodexCompatibility({
          suiteId,
          readSource: (path) => sources.selected.readText(path),
        })
      : { runLane: true };
    contracts.push({
      consumer: suiteId,
      status: result.runLane ? "ADMITTED" : "NOT RUN",
      ...(result.model ? { model: result.model } : {}),
    });
  }
  if (fsSafeNative) {
    contracts.push({
      consumer: "fs-safe-native",
      mode: resolveFsSafeNativeContract({
        selectedSha: input.selected.sha,
        workflowSha: input.tooling.sha,
        allowFrozenSource: allow,
        containingBranches: () =>
          sources.selected.containingBranches("refs/remotes/origin/extended-stable"),
        readSource: (path) => sources.selected.readText(path),
      }),
    });
  }
  const record = {
    version: 1,
    repository: input.repository,
    selectedSha: input.selected.sha,
    toolingSha: input.tooling.sha,
    selection: {
      consumers: [...consumers].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      codexSuites,
      fsSafeNative,
      allowFrozenTargetScenarioOmissions: allow,
      ...(normalizedDocker ? { docker: normalizedDocker } : {}),
    },
    contracts,
    ...(docker ? { docker } : {}),
    sources: {
      selected: sources.selected.blobIdentities(),
      tooling: verifiedTooling
        ? [
            ...new Map(
              [...verifiedTooling.identities, ...sources.tooling.blobIdentities()].map(
                (identity) => [identity.path, identity],
              ),
            ).values(),
          ].toSorted((a, b) => a.path.localeCompare(b.path))
        : sources.tooling.blobIdentities(),
    },
  };
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > maxRecordBytes) {
    throw new Error("admission record exceeds limit");
  }
  return { ...record, digest: createHash("sha256").update(serialized).digest("hex") };
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain =
      realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1]);
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}

if (invokedAsMain) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--workflow-request") {
      process.stdout.write(`${JSON.stringify(workflowRequest(process.env))}\n`);
      process.exit(0);
    }
    if (args[0] === "--verify-tooling") {
      if (args.length !== 3) {
        throw new Error("expected exact tooling root and SHA");
      }
      await loadVerifiedTooling({ root: args[1], sha: args[2] }, true);
      process.exit(0);
    }
    const planOnly = args[0] === "--plan";
    const [file, ...extra] = planOnly ? args.slice(1) : args;
    if (!file || extra.length || !statSync(file).isFile() || statSync(file).size > 64 * 1024) {
      throw new Error("expected one bounded admission request file");
    }
    const input = JSON.parse(readFileSync(file, "utf8"));
    const result = planOnly
      ? await planWorkflowAdmission(input)
      : input.version === 2
        ? await preflightWorkflow(input)
        : await preflightFrozenTargetContracts(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`frozen admission: ${error.message}`);
    process.exitCode = 1;
  }
}
