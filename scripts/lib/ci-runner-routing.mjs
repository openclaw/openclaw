// Runner selection belongs to the trusted CI planner; workflows consume its JSON selectors.
function resolveCiRunner({
  jobId,
  matrix = {},
  eventName,
  repository,
  headRepository = "",
  runAttempt = 1,
  runnerBackend = "",
  dispatchId = "",
  releaseRunnerGroup = "",
  preflightOutputs: p = {},
  ref = "",
  releaseGate = false,
  failureReport = false,
  runId = "",
}) {
  const upstream = repository === "openclaw/openclaw";
  const fork = headRepository !== repository;
  const dispatch = eventName === "workflow_dispatch";
  const pullRequest = eventName === "pull_request";
  const releaseDispatch = dispatch && dispatchId.startsWith("full-release-validation-");
  const backend =
    p.ci_qualification === "true"
      ? runAttempt === 1
        ? p.qualification_runner_backend || "github"
        : "github"
      : runnerBackend;
  const firstAttemptBackend =
    p.ci_qualification === "true" ? p.qualification_runner_backend || runnerBackend : runnerBackend;
  const elastic = ["hybrid", "runson"].includes(backend);
  const firstAttemptElastic = ["hybrid", "runson"].includes(firstAttemptBackend);
  const dispatchFallback =
    dispatch &&
    ((p.node_runner_backend !== "runson" && p.ci_qualification !== "true") || runAttempt !== 1);
  const hostedFallback =
    backend === "github" ||
    (elastic && runAttempt > 1) ||
    dispatchFallback ||
    (pullRequest && fork && runAttempt > 1);
  const choose = (capacity, hosted = hostedFallback) =>
    hosted || !upstream ? "ubuntu-24.04" : `blacksmith-${capacity}vcpu-ubuntu-2404`;
  let label;
  switch (jobId) {
    case "security-fast":
      label =
        (elastic &&
          p.hybrid_hosted_offload != "true" &&
          runAttempt == 1 &&
          (!dispatch ||
            ((p.node_runner_backend == "runson" || p.ci_qualification == "true") &&
              runAttempt == 1)) &&
          upstream &&
          "blacksmith-4vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "build-artifacts":
      label = choose(16);
      break;
    case "control-ui-performance":
    case "native-i18n":
    case "control-ui-i18n":
    case "checks-fast-plugin-contracts-shard":
    case "checks-fast-channel-contracts-shard":
    case "checks-node-compat":
    case "skills-python":
      label = choose(4, hostedFallback || elastic);
      break;
    case "checks-ui":
      label =
        (hostedFallback && "ubuntu-24.04") ||
        (elastic && upstream && "blacksmith-8vcpu-ubuntu-2404") ||
        (upstream && "blacksmith-4vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "checks-ui-e2e":
      label =
        (elastic &&
          p.hybrid_hosted_offload == "true" &&
          matrix.task == "browser-extension" &&
          "ubuntu-24.04") ||
        (backend == "github" && "ubuntu-24.04") ||
        (elastic && runAttempt > 1 && "ubuntu-24.04") ||
        ((dispatchFallback || (pullRequest && runAttempt > 1)) && "ubuntu-24.04") ||
        (upstream &&
          ((matrix.task == "control-ui" && "blacksmith-16vcpu-ubuntu-2404") ||
            "blacksmith-8vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "checks-ui-e2e-real-gateway":
      label =
        (backend == "github" && "ubuntu-24.04") ||
        (elastic && runAttempt > 1 && "ubuntu-24.04") ||
        ((dispatchFallback || (pullRequest && runAttempt > 1)) && "ubuntu-24.04") ||
        (upstream &&
          ((p.frozen_target == "false" && "blacksmith-16vcpu-ubuntu-2404") ||
            "blacksmith-32vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "checks-baseline-ratchets":
      label =
        ((backend == "github" ||
          backend == "runson" ||
          (backend == "hybrid" &&
            (runAttempt != 1 ||
              (pullRequest && fork) ||
              p.node_runner_backend == "runson" ||
              (dispatch && p.ci_qualification != "true") ||
              p.frozen_target == "true"))) &&
          "ubuntu-24.04") ||
        ((dispatchFallback || (pullRequest && fork && runAttempt > 1)) && "ubuntu-24.04") ||
        (upstream && "blacksmith-4vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "checks-fast-core":
      label =
        ((backend == "github" || elastic) && "ubuntu-24.04") ||
        ((dispatchFallback || (pullRequest && fork && runAttempt > 1)) && "ubuntu-24.04") ||
        (upstream && (matrix.runner || "blacksmith-4vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "qa-smoke-ci-profile":
      label =
        (upstream &&
          ref == "refs/heads/main" &&
          (eventName == "push" || eventName == "schedule") &&
          runAttempt == 1 &&
          runnerBackend == "hybrid" &&
          p.runner_profile == "hybrid" &&
          p.frozen_target == "false" &&
          p.compatibility_target == "false" &&
          matrix.part_count == 4 &&
          "blacksmith-8vcpu-ubuntu-2404") ||
        choose(16);
      break;
    case "checks-node-core-test-nondist-shard":
      label =
        (p.node_runner_backend == "runson" &&
          matrix.runner == "runson-c8i-8xlarge" &&
          runAttempt == 1 &&
          `runs-on=${runId}-${matrix.check_name}/family=c8i.8xlarge/cpu=32/ram=64/spot=true/retry=false/image=ubuntu24-full-x64/volume=80gb`) ||
        (matrix.runner == "runson-c8i-8xlarge" && "ubuntu-24.04") ||
        ((p.node_runner_backend == "runson" || p.ci_qualification == "true") &&
          runAttempt == 1 &&
          ((matrix.runner == "blacksmith-8vcpu-ubuntu-2404" &&
            ["checks-node-compact-large-9", "checks-node-compact-large-5"].includes(
              matrix.check_name,
            ) &&
            "blacksmith-16vcpu-ubuntu-2404") ||
            matrix.runner ||
            "blacksmith-4vcpu-ubuntu-2404")) ||
        (hostedFallback && "ubuntu-24.04") ||
        (upstream &&
          ((matrix.runner == "blacksmith-8vcpu-ubuntu-2404" &&
            ["checks-node-compact-large-9", "checks-node-compact-large-5"].includes(
              matrix.check_name,
            ) &&
            "blacksmith-16vcpu-ubuntu-2404") ||
            matrix.runner ||
            "blacksmith-4vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "check-plan":
      label =
        (["", "blacksmith", "hybrid"].includes(backend) &&
          !(pullRequest && runnerBackend == "hybrid" && !fork) &&
          p.node_runner_backend != "runson" &&
          runAttempt == 1 &&
          (!dispatch || p.ci_qualification == "true") &&
          p.frozen_target != "true" &&
          upstream &&
          "blacksmith-16vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "check-shard":
      label =
        (elastic &&
          runAttempt == 1 &&
          ((p.hybrid_hosted_checks == "true" && matrix.task == "dependencies") ||
            (p.hybrid_hosted_main_checks == "true" &&
              (matrix.task == "lint" || matrix.task == "test-types"))) &&
          "ubuntu-24.04") ||
        (backend == "github" && "ubuntu-24.04") ||
        (elastic &&
          upstream &&
          dispatchFallback &&
          !releaseGate &&
          releaseDispatch &&
          p.frozen_target == "true" &&
          matrix.task == "lint" &&
          (matrix.runner || "blacksmith-4vcpu-ubuntu-2404")) ||
        (elastic &&
          (dispatchFallback ||
            runAttempt > 1 ||
            (matrix.task != "lint" &&
              matrix.task != "test-types" &&
              matrix.task != "dependencies")) &&
          "ubuntu-24.04") ||
        (((dispatchFallback && releaseGate) || (pullRequest && fork && runAttempt > 1)) &&
          "ubuntu-24.04") ||
        (upstream && (matrix.runner || "blacksmith-4vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "check-lint-hosted-core-shard":
      label =
        ((firstAttemptElastic || (["", "blacksmith"].includes(firstAttemptBackend) && !dispatch)) &&
          runAttempt == 1 &&
          upstream &&
          (!dispatch || p.ci_qualification == "true" || p.node_runner_backend == "runson") &&
          p.frozen_target != "true" &&
          (((firstAttemptBackend != "runson" ||
            (p.runner_profile == "hybrid" && matrix.stripe == 1)) &&
            "blacksmith-16vcpu-ubuntu-2404") ||
            "blacksmith-8vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "check-lint-hosted-extension-shard":
    case "postgres-conformance":
    case "check-docs":
    case "ios-screenshot-evidence":
    case "android-screenshots":
    case "android-access-native":
      label = "ubuntu-24.04";
      break;
    case "check-test-types-hosted-core-shard":
      label =
        (elastic && runAttempt == 1 && p.hybrid_hosted_checks == "true" && "ubuntu-24.04") ||
        (backend == "github" && "ubuntu-24.04") ||
        (elastic && runAttempt > 1 && "ubuntu-24.04") ||
        (dispatchFallback && "ubuntu-24.04") ||
        ((elastic ||
          (["", "blacksmith"].includes(backend) &&
            runAttempt == 1 &&
            !dispatch &&
            p.frozen_target != "true")) &&
          upstream &&
          "blacksmith-16vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "check-additional-shard":
      label =
        (elastic &&
          runAttempt == 1 &&
          p.hybrid_hosted_checks == "true" &&
          ["runtime-topology-architecture", "dependencies"].includes(matrix.group) &&
          "ubuntu-24.04") ||
        (backend == "github" && "ubuntu-24.04") ||
        (elastic &&
          (runAttempt > 1 ||
            ![
              "extension-package-boundary",
              "runtime-topology-architecture",
              "plugin-sdk-api-diff",
              "dependencies",
            ].includes(matrix.group)) &&
          "ubuntu-24.04") ||
        ((dispatchFallback || (pullRequest && fork && runAttempt > 1)) && "ubuntu-24.04") ||
        (upstream && (matrix.runner || "blacksmith-4vcpu-ubuntu-2404")) ||
        "ubuntu-24.04";
      break;
    case "check-extension-package-boundary":
      label =
        (runAttempt == 1 && runnerBackend != "github" && "blacksmith-16vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "checks-windows":
      label =
        (backend == "github" && "windows-2025") ||
        (elastic && runAttempt > 1 && "windows-2025") ||
        ((dispatchFallback || (pullRequest && fork && runAttempt > 1)) && "windows-2025") ||
        (upstream && "blacksmith-16vcpu-windows-2025") ||
        "windows-2025";
      break;
    case "macos-node":
      label =
        ((backend == "github" || elastic) && "macos-15") ||
        ((dispatchFallback || runAttempt > 1) && "macos-15") ||
        (upstream && "blacksmith-6vcpu-macos-15") ||
        "macos-15";
      break;
    case "macos-swift":
    case "ios-build":
      label = "xcode-27";
      break;
    case "ios-screenshot-shard":
      label = "xcode-27-xlarge";
      break;
    case "android":
      label = choose(8);
      break;
    case "docker-seed-e2e":
      label =
        (backend == "github" && "ubuntu-24.04") ||
        (elastic && runAttempt > 1 && "ubuntu-24.04") ||
        (dispatchFallback && "ubuntu-24.04") ||
        (pullRequest && (runAttempt > 1 || fork) && "ubuntu-24.04") ||
        (upstream && "blacksmith-16vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    case "ci-gate":
      label =
        (runnerBackend == "hybrid" && !dispatch && (!pullRequest || !fork) && "ubuntu-24.04") ||
        (((firstAttemptElastic &&
          runAttempt == 1 &&
          upstream &&
          (!dispatch || p.ci_qualification == "true" || p.node_runner_backend == "runson")) ||
          (pullRequest &&
            runAttempt == 1 &&
            upstream &&
            !fork &&
            runnerBackend != "github" &&
            p.runner_profile == "blacksmith" &&
            failureReport)) &&
          "blacksmith-4vcpu-ubuntu-2404") ||
        "ubuntu-24.04";
      break;
    default:
      throw new Error(`Unknown CI runner policy: ${jobId}`);
  }
  // Docker release dispatches select a larger runner class even when ordinary dispatches use hosted Ubuntu.
  if (
    jobId === "docker-seed-e2e" &&
    releaseDispatch &&
    upstream &&
    runAttempt === 1 &&
    firstAttemptBackend !== "github" &&
    !releaseRunnerGroup
  ) {
    label = "blacksmith-16vcpu-ubuntu-2404";
  }
  return jobId !== "check-extension-package-boundary" && releaseDispatch && releaseRunnerGroup
    ? { group: releaseRunnerGroup, labels: label }
    : label;
}

const CI_RUNNER_JOBS = [
  "security-fast",
  "build-artifacts",
  "control-ui-performance",
  "native-i18n",
  "checks-ui",
  "checks-ui-e2e",
  "checks-ui-e2e-real-gateway",
  "control-ui-i18n",
  "checks-baseline-ratchets",
  "checks-fast-core",
  "qa-smoke-ci-profile",
  "checks-fast-plugin-contracts-shard",
  "checks-fast-channel-contracts-shard",
  "checks-node-compat",
  "checks-node-core-test-nondist-shard",
  "check-plan",
  "check-shard",
  "check-lint-hosted-core-shard",
  "check-lint-hosted-extension-shard",
  "check-test-types-hosted-core-shard",
  "check-additional-shard",
  "check-extension-package-boundary",
  "postgres-conformance",
  "check-docs",
  "skills-python",
  "checks-windows",
  "macos-node",
  "macos-swift",
  "ios-build",
  "ios-screenshot-shard",
  "ios-screenshot-evidence",
  "android",
  "android-screenshots",
  "android-access-native",
  "docker-seed-e2e",
  "ci-gate",
];
function resolveCiRunnerRouting(context) {
  return Object.fromEntries(
    CI_RUNNER_JOBS.map((jobId) => [jobId, resolveCiRunner({ ...context, jobId })]),
  );
}

// The lookup dimensions mirror the few matrix fields that affect placement.
export function createCiRunnerMap(context, manifest = {}) {
  const runners = resolveCiRunnerRouting(context);
  const capacities = [
    ...new Set([
      "default",
      "ubuntu-24.04",
      "blacksmith-4vcpu-ubuntu-2404",
      "blacksmith-8vcpu-ubuntu-2404",
      "blacksmith-16vcpu-ubuntu-2404",
      "blacksmith-32vcpu-ubuntu-2404",
      "runson-c8i-8xlarge",
      ...Object.values(manifest).flatMap((value) =>
        value && typeof value === "object" && Array.isArray(value.include)
          ? value.include.flatMap((row) => (typeof row.runner === "string" ? [row.runner] : []))
          : [],
      ),
    ]),
  ];
  const by = (jobId, values, field) =>
    Object.fromEntries(
      values.map((value) => [
        value,
        resolveCiRunner({
          ...context,
          jobId,
          matrix: { [field]: value === "default" ? "" : value },
        }),
      ]),
    );
  runners["checks-ui-e2e"] = by("checks-ui-e2e", ["control-ui", "browser-extension"], "task");
  runners["checks-fast-core"] = by("checks-fast-core", capacities, "runner");
  runners["qa-smoke-ci-profile"] = {
    four: resolveCiRunner({ ...context, jobId: "qa-smoke-ci-profile", matrix: { part_count: 4 } }),
    default: resolveCiRunner({ ...context, jobId: "qa-smoke-ci-profile" }),
  };
  runners["check-lint-hosted-core-shard"] = {
    first: resolveCiRunner({
      ...context,
      jobId: "check-lint-hosted-core-shard",
      matrix: { stripe: 1 },
    }),
    default: resolveCiRunner({ ...context, jobId: "check-lint-hosted-core-shard" }),
  };
  // Node check names are unique row identities; retain the actual name in RunsOn lease selectors.
  runners["checks-node-core-test-nondist-shard"] = Object.fromEntries([
    [
      "default",
      resolveCiRunner({
        ...context,
        jobId: "checks-node-core-test-nondist-shard",
        matrix: context.matrix ?? {},
      }),
    ],
    ...(manifest.checks_node_core_nondist_matrix?.include ?? []).map((matrix) => [
      matrix.check_name,
      resolveCiRunner({ ...context, jobId: "checks-node-core-test-nondist-shard", matrix }),
    ]),
    ...(context.matrix?.check_name
      ? [
          [
            context.matrix.check_name,
            resolveCiRunner({
              ...context,
              jobId: "checks-node-core-test-nondist-shard",
              matrix: context.matrix,
            }),
          ],
        ]
      : []),
  ]);
  for (const [jobId, field, values] of [
    [
      "check-shard",
      "task",
      [
        "lint",
        "test-types",
        "dependencies",
        "prod-types",
        "guards",
        "default",
        ...(manifest.check_matrix?.include ?? []).map((row) => row.task),
      ],
    ],
    [
      "check-additional-shard",
      "group",
      [
        "extension-package-boundary",
        "runtime-topology-architecture",
        "plugin-sdk-api-diff",
        "dependencies",
        "default",
        ...(manifest.check_additional_matrix?.include ?? []).map((row) => row.group),
      ],
    ],
  ]) {
    runners[jobId] = Object.fromEntries(
      [...new Set(values)].map((value) => [
        value,
        Object.fromEntries(
          capacities.map((runner) => [
            runner,
            resolveCiRunner({
              ...context,
              jobId,
              matrix: { [field]: value, runner: runner === "default" ? "" : runner },
            }),
          ]),
        ),
      ]),
    );
  }
  runners.gate_failure = resolveCiRunner({ ...context, jobId: "ci-gate", failureReport: true });
  return runners;
}
