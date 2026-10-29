import { createHash } from "node:crypto";
import { validateQualificationBaselines } from "./release-upgrade-baseline.mjs";

export function frozenAdmissionText(value, label, limit = 4096) {
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

export function buildFrozenTargetWorkflowRequest(env) {
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
  const packedBaselines =
    get("qualification_baselines_json") ||
    (env.ADMISSION_WORKFLOW === "parent" && get("trusted_workflow_json")
      ? (JSON.parse(get("trusted_workflow_json")).laneInputs?.qualification_baselines_json ?? "")
      : "");
  const qualificationBaselines = packedBaselines
    ? validateQualificationBaselines(JSON.parse(packedBaselines))
    : null;
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
      qualificationBaselines?.upgradeBaseline ??
      env.ADMISSION_BASELINE ??
      get("published_upgrade_survivor_baseline", "openclaw@latest"),
    upgradeSurvivorBaselines:
      qualificationBaselines?.upgradeSurvivorBaselines.join(" ") ??
      env.ADMISSION_BASELINES ??
      get("published_upgrade_survivor_baselines"),
    upgradeSurvivorBaselineScope:
      env.ADMISSION_BASELINE_SCOPE ??
      get("published_upgrade_survivor_baseline_scope", "all-scenarios"),
    upgradeSurvivorScenarios: get("published_upgrade_survivor_scenarios"),
    baselinesResolved:
      qualificationBaselines !== null || env.ADMISSION_BASELINES_RESOLVED === "true",
    packageOverride: Boolean(String(get("release_package_spec")).trim()),
    acceptanceOverride: Boolean(String(get("package_acceptance_package_spec")).trim()),
  };
  const workflow = env.ADMISSION_WORKFLOW;
  if (workflow === "parent") {
    options.upgradeSurvivorScenarios = options.runReleaseSoak ? "reported-issues" : "";
  }
  return {
    version: 2,
    repository: frozenAdmissionText(env.GITHUB_REPOSITORY, "repository"),
    selected: {
      root: frozenAdmissionText(env.ADMISSION_SELECTED_ROOT, "selected root"),
      sha: frozenAdmissionText(env.ADMISSION_SELECTED_SHA, "selected SHA"),
    },
    tooling: {
      root: frozenAdmissionText(env.ADMISSION_TOOLING_ROOT, "tooling root"),
      sha: frozenAdmissionText(env.ADMISSION_TOOLING_SHA, "tooling SHA"),
    },
    allowFrozenTargetScenarioOmissions:
      flag(get("allow_frozen_target_scenario_omissions")) ||
      (workflow === "parent" &&
        Boolean(get("target_context_ref")) &&
        env.ADMISSION_SELECTED_SHA !== env.ADMISSION_TOOLING_SHA),
    workflow,
    options,
    requestedBaselines: {
      baseline:
        qualificationBaselines?.upgradeBaseline ??
        get("published_upgrade_survivor_baseline", "openclaw@latest"),
      baselines:
        qualificationBaselines?.upgradeSurvivorBaselines.join(" ") ??
        get("published_upgrade_survivor_baselines"),
      scope: get("published_upgrade_survivor_baseline_scope", "all-scenarios"),
      scenarios: options.upgradeSurvivorScenarios,
    },
    binding: {
      workflowRef: frozenAdmissionText(env.ADMISSION_WORKFLOW_REF, "workflow ref"),
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
      coveragePolicy: frozenAdmissionText(env.ADMISSION_COVERAGE_POLICY ?? "", "coverage policy"),
      candidateRequestDigest: frozenAdmissionText(
        env.ADMISSION_CANDIDATE_REQUEST_DIGEST ?? "",
        "candidate request digest",
      ),
      packageSourceSha: frozenAdmissionText(
        env.ADMISSION_PACKAGE_SOURCE_SHA ?? "",
        "package source SHA",
      ),
      packageSha256: frozenAdmissionText(env.ADMISSION_PACKAGE_SHA256 ?? "", "package digest"),
      packageVersion: frozenAdmissionText(env.ADMISSION_PACKAGE_VERSION ?? "", "package version"),
      stage: frozenAdmissionText(env.ADMISSION_STAGE ?? "source", "admission stage"),
    },
    provenance: {
      runId: frozenAdmissionText(env.GITHUB_RUN_ID, "run id"),
      runAttempt: frozenAdmissionText(env.GITHUB_RUN_ATTEMPT, "run attempt"),
    },
  };
}
