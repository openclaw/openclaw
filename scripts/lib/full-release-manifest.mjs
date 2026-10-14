// The manifest producer projects the immutable plan and its current workflow context.
import {
  publicationIntentInputs,
  validatePublicationAdmissionBinding,
} from "../full-release-publication-contract.mjs";
import { serializeReleaseArtifact } from "./full-release-evidence.mjs";

export function releaseManifestChildEvidence(child) {
  return {
    runId: child.runId,
    plannedRunAttempt: child.plannedRunAttempt,
    effectiveRunAttempt: child.runAttempt,
    observedRunAttempts: child.observedRunAttempts,
    compositeJobsSha256: child.compositeJobsSha256,
    dispatchActor: child.dispatchActor,
    triggeringActor: child.triggeringActor,
    repository: child.repository,
    jobs: child.timing.jobs.map(
      ({ name, status, conclusion, acceptedRunAttempt, startedAt, completedAt, url }) => ({
        name,
        status,
        conclusion,
        acceptedRunAttempt,
        startedAt,
        completedAt,
        url,
      }),
    ),
  };
}

export function buildReleaseValidationManifest({ plan, drain, context }) {
  const childEvidence = Object.fromEntries(
    Object.entries(drain?.children ?? {}).map(([key, child]) => [
      key,
      releaseManifestChildEvidence(child),
    ]),
  );
  const current = {
    version: 4,
    runId: context.runId,
    runAttempt: context.runAttempt,
    workflowRef: context.workflowRef,
    workflowSha: context.workflowSha,
    workflowFullRef: context.workflowFullRef,
    workflowRefType: context.workflowRefType,
    targetRef: context.targetRef,
    targetSha: plan.targetSha,
    candidateBinding: plan.candidate,
    publicationArtifacts: context.publicationArtifacts ?? { npmPreflight: null, docker: null },
    publishInputs: context.publishInputs,
    // Keep the wire field; current release policy admits no advisory jobs.
    advisoryJobs: [],
    childEvidence,
    ...(plan.qualificationCoverage
      ? {
          qualificationCoverage: plan.qualificationCoverage,
          qualificationInputs: plan.qualificationInputs,
        }
      : {}),
    executionPlanSha256: plan.sha256,
    sourceParentRunAttempt: Number(plan.parentRunAttempt),
    ...(plan.sourceAdmissionContract
      ? {
          sourceAdmissionContract: plan.sourceAdmissionContract,
          sourceAdmission: plan.sourceAdmission,
          trustedWorkflow: plan.trustedWorkflow,
        }
      : {}),
    ...(plan.publicationAdmissionContract
      ? {
          publicationAdmissionContract: plan.publicationAdmissionContract,
          publicationAdmission: plan.publicationAdmission,
        }
      : {}),
  };
  const runs = Object.fromEntries(plan.children.map((child) => [child.key, child.runId]));
  const root = plan.evidenceReuse.sourceManifest;
  let rootPublication;
  if (plan.evidenceReuse.requested && root?.publicationAdmissionContract !== undefined) {
    rootPublication = {
      sourceAdmissionContract: root.sourceAdmissionContract,
      sourceAdmission: root.sourceAdmission,
      publicationAdmissionContract: root.publicationAdmissionContract,
      publicationAdmission: root.publicationAdmission,
    };
    validatePublicationAdmissionBinding(rootPublication);
    if (
      root.sourceAdmission.runId !== plan.evidenceReuse.rootRunId ||
      root.sourceAdmission.candidateSha !== plan.evidenceReuse.evidenceSha
    ) {
      throw new Error("reused publication admission differs from the retained root identity");
    }
  }
  const manifest = plan.evidenceReuse.requested
    ? {
        ...plan.evidenceReuse.sourceManifest,
        ...current,
        evidenceReuse: {
          policy: plan.evidenceReuse.policy,
          runId: plan.evidenceReuse.rootRunId,
          selectedRunId: plan.evidenceReuse.selectedRunId,
          evidenceSha: plan.evidenceReuse.evidenceSha,
          changedPaths: plan.evidenceReuse.changedPaths ?? [],
          ...(rootPublication ? { publication: rootPublication } : {}),
        },
        controls: {
          ...plan.evidenceReuse.sourceManifest.controls,
          performanceReportPublication: "artifact-only",
        },
      }
    : {
        ...current,
        workflowName: "Full Release Validation",
        releaseProfile: context.releaseProfile,
        rerunGroup: context.rerunGroup,
        runReleaseSoak: context.runReleaseSoak,
        validationInputs: {
          ...context.validationInputs,
          ...(plan.sourceAdmissionContract
            ? {
                ...publicationIntentInputs(plan.sourceAdmission),
              }
            : {}),
          ...(plan.coveragePolicy ? { coveragePolicy: plan.coveragePolicy } : {}),
        },
        controls: {
          stableSoakRequired: ["stable", "full"].includes(context.releaseProfile),
          performanceBlocking: context.releaseProfile !== "beta",
          performanceReportPublication: "artifact-only",
        },
        childRuns: plan.qualificationCoverage
          ? Object.fromEntries(
              plan.children.map((child) => [
                child.key,
                child.key === "productPerformance"
                  ? {
                      runId: child.runId,
                      conclusion: drain?.children?.productPerformance?.conclusion ?? "",
                      blocking: context.releaseProfile !== "beta",
                    }
                  : child.runId,
              ]),
            )
          : {
              normalCi: runs.normalCi ?? "",
              pluginPrereleaseIndependent: runs.pluginPrereleaseIndependent ?? "",
              pluginPrereleaseCandidate: runs.pluginPrereleaseCandidate ?? "",
              releaseChecksIndependent: runs.releaseChecksIndependent ?? "",
              releaseChecksCandidate: runs.releaseChecksCandidate ?? "",
              npmTelegram: runs.npmTelegram ?? "",
              productPerformance: {
                runId: runs.productPerformance ?? "",
                conclusion: drain?.children?.productPerformance?.conclusion ?? "",
                blocking: context.releaseProfile !== "beta",
              },
            },
      };
  serializeReleaseArtifact(manifest);
  return manifest;
}

export function manifestContextFromEnvironment(source) {
  const env = process.env;
  const coverage = source?.coverage ?? {};
  const inputs = {};
  for (const [key, variable, sourceKey] of [
    ["provider", "PROVIDER", "provider"],
    ["mode", "MODE", "mode"],
    ["liveSuiteFilter", "LIVE_SUITE_FILTER", "live_suite_filter"],
    ["crossOsSuiteFilter", "CROSS_OS_SUITE_FILTER", "cross_os_suite_filter"],
    ["releasePackageSpec", "RELEASE_PACKAGE_SPEC", "release_package_spec"],
    [
      "packageAcceptancePackageSpec",
      "PACKAGE_ACCEPTANCE_PACKAGE_SPEC",
      "package_acceptance_package_spec",
    ],
    ["codexPluginSpec", "CODEX_PLUGIN_SPEC", "codex_plugin_spec"],
    ["npmTelegramPackageSpec", "NPM_TELEGRAM_PACKAGE_SPEC", "npm_telegram_package_spec"],
    ["npmTelegramProviderMode", "NPM_TELEGRAM_PROVIDER_MODE", "npm_telegram_provider_mode"],
    ["npmTelegramScenario", "NPM_TELEGRAM_SCENARIO", "npm_telegram_scenario"],
    ["skipPackageTelegramE2e", "SKIP_PACKAGE_TELEGRAM_E2E", "skip_package_telegram_e2e"],
    ["allowUnreleasedChangelog", "ALLOW_UNRELEASED_CHANGELOG", "allow_unreleased_changelog"],
    [
      "pluginPrereleaseNodeExcludePatternsJson",
      "PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON",
      "plugin_prerelease_node_exclude_patterns_json",
    ],
    [
      "extensionTestExcludePatternsJson",
      "EXTENSION_TEST_EXCLUDE_PATTERNS_JSON",
      "extension_test_exclude_patterns_json",
    ],
  ]) {
    inputs[key] = env[variable] ?? coverage[sourceKey] ?? "";
  }
  const qualificationBaselines =
    env.QUALIFICATION_BASELINES_JSON ?? coverage.qualification_baselines_json;
  if (qualificationBaselines) {
    inputs.qualificationBaselinesJson = qualificationBaselines;
  }
  inputs.targetContextRef = env.TARGET_CONTEXT_REF ?? source?.targetContextRef ?? "";
  inputs.targetVersion = env.TARGET_VERSION ?? source?.projection?.version ?? "";
  const waiver = env.TELEGRAM_WAIVER ?? coverage.telegram_waiver ?? "";
  if (waiver) {
    inputs.telegramWaiver = waiver;
  }
  return {
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    workflowRef: env.GITHUB_REF_NAME,
    workflowSha: env.GITHUB_SHA,
    workflowFullRef: env.GITHUB_REF,
    workflowRefType: env.GITHUB_REF_TYPE,
    targetRef: env.TARGET_REF ?? source?.targetContextRef ?? "",
    releaseProfile: env.RELEASE_PROFILE ?? coverage.release_profile ?? "",
    rerunGroup: env.RERUN_GROUP ?? coverage.rerun_group ?? "",
    runReleaseSoak: env.RUN_RELEASE_SOAK ?? coverage.run_release_soak ?? "",
    validationInputs: inputs,
    publicationArtifacts: {
      npmPreflight: JSON.parse(env.QUALIFIED_NPM_BUNDLE_JSON || "null"),
      pluginNpm: JSON.parse(env.PREPARED_PLUGIN_NPM_JSON || "null"),
      docker: env.PREPARED_DOCKER_MANIFEST_SHA256
        ? {
            preparedRunId: env.PREPARED_DOCKER_RUN_ID,
            preparedRunAttempt: env.PREPARED_DOCKER_RUN_ATTEMPT,
            preparedArtifactName: env.PREPARED_DOCKER_ARTIFACT_NAME,
            preparedManifestSha256: env.PREPARED_DOCKER_MANIFEST_SHA256,
          }
        : null,
    },
  };
}
