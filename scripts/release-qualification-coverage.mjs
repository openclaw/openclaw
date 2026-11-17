import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse as parseJavaScript } from "@babel/parser";
import { parse as parseYaml } from "yaml";
import { canonicalAsciiJson, compareAscii } from "./lib/canonical-json.mjs";
import { resolveRunnerMatrix } from "./lib/cross-os-release-checks/config.ts";
import { isRecord } from "./lib/record-shared.mjs";
import { compareReleaseVersions, parseReleaseVersion } from "./lib/release-version.mjs";
import { isPackageRecoveryScenario } from "./lib/upgrade-survivor-policy.mjs";
import { createReleaseCheckSelection } from "./plan-release-workflow-matrix.mjs";
import { planTargetedDockerLaneGroups } from "./plan-targeted-docker-lane-groups.mjs";

export const QUALIFICATION_COVERAGE_PATH = "scripts/lib/release-qualification-coverage.json";
const SCHEMA = "openclaw.release-qualification-coverage/v1";

export function qualificationAdmissionContract(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 1024 * 1024) {
    throw new Error("Invalid qualification workflow source");
  }
  const matches = [
    ...source.matchAll(/^ {2}FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT: *([^\r\n]+)$/gmu),
  ];
  if (!matches.length && !source.includes("FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT")) {
    return undefined;
  }
  if (matches.length !== 1 || !/^(?:"1"|'1'|1)$/u.test(matches[0][1])) {
    throw new Error("Unsupported qualification admission workflow contract");
  }
  return "1";
}

function object(value, keys, label) {
  if (
    !isRecord(value) ||
    !isDeepStrictEqual(Object.keys(value).toSorted(compareAscii), [...keys].toSorted(compareAscii))
  ) {
    throw new Error(label + " has unexpected fields");
  }
}

function literal(value, label) {
  if (typeof value !== "string" || !/^[\x20-\x7e]{1,200}$/u.test(value)) {
    throw new Error(label + " must be bounded printable ASCII");
  }
  return value;
}

function names(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > 256 || (!allowEmpty && !value.length)) {
    throw new Error(label + " must be a bounded nonempty array");
  }
  const result = value.map((name) => literal(name, label));
  if (new Set(result).size !== result.length) {
    throw new Error(label + " contains duplicate identities");
  }
  return result;
}

// This is data validation, never candidate-code evaluation. P reads this document
// from immutable Q, seals the selected coverage, then verifies the same literals.
export function validateQualificationCoverage(value) {
  object(
    value,
    [
      "schema",
      "profile",
      "children",
      "requiredParentJobs",
      ...(value?.exemptions === undefined ? [] : ["exemptions"]),
    ],
    "qualification coverage",
  );
  if (
    value.exemptions !== undefined &&
    (!Array.isArray(value.exemptions) ||
      value.exemptions.length !== 1 ||
      value.exemptions[0]?.childRole !== "productPerformance" ||
      value.exemptions[0]?.disposition !== "waived-not-run" ||
      !Array.isArray(value.children) ||
      value.children.some((child) => child.key === "productPerformance"))
  ) {
    throw new Error("Invalid explicit qualification exemption");
  }
  if (value.schema !== SCHEMA || !["beta", "stable", "full"].includes(value.profile)) {
    throw new Error("Unsupported qualification coverage schema or profile");
  }
  if (!Array.isArray(value.children) || !value.children.length || value.children.length > 32) {
    throw new Error("Qualification coverage requires a bounded child inventory");
  }
  const children = value.children.map((child) => {
    object(
      child,
      ["key", "workflow", "name", "parentJobName", "dispatchName", "suffix", "requiredJobs"],
      "qualification child",
    );
    for (const key of ["key", "workflow", "name", "parentJobName", "dispatchName"]) {
      literal(child[key], "qualification child " + key);
    }
    if (
      !/^[A-Za-z][A-Za-z0-9]*$/u.test(child.key) ||
      !/^[a-z0-9-]+\.yml$/u.test(child.workflow) ||
      typeof child.suffix !== "string" ||
      !/^(?:-[a-z0-9-]+)?$/u.test(child.suffix)
    ) {
      throw new Error("Invalid qualification child identity");
    }
    return {
      ...child,
      requiredJobs: names(child.requiredJobs, "qualification child requiredJobs"),
    };
  });
  for (const field of ["key", "parentJobName", "dispatchName", "suffix"]) {
    if (new Set(children.map((child) => child[field])).size !== children.length) {
      throw new Error("Duplicate qualification child " + field);
    }
  }
  const coverage = {
    schema: SCHEMA,
    profile: value.profile,
    children,
    requiredParentJobs: names(value.requiredParentJobs, "qualification requiredParentJobs"),
    ...(value.exemptions === undefined ? {} : { exemptions: value.exemptions }),
  };
  if (Buffer.byteLength(canonicalAsciiJson(coverage)) > 32 * 1024) {
    throw new Error("Qualification coverage exceeds 32 KiB");
  }
  return coverage;
}

export function qualificationCoverageSha256(value) {
  return createHash("sha256")
    .update(canonicalAsciiJson(validateQualificationCoverage(value)))
    .digest("hex");
}

export function resolveQualificationCoverage(policy, inputs) {
  object(
    policy,
    ["schema", "profiles", "children", "requiredParentJobs"],
    "qualification coverage policy",
  );
  object(policy.profiles, ["beta", "stable", "full"], "qualification coverage profiles");
  if (policy.schema !== "openclaw.release-qualification-policy/v1") {
    throw new Error("Unsupported qualification policy schema");
  }
  const profile = inputs.release_profile;
  if (!["beta", "stable", "full"].includes(profile) || inputs.rerun_group !== "all") {
    throw new Error("Candidate-owned qualification requires a full profile and all groups");
  }
  // Policy v1 means complete fresh and backward-upgrade coverage, not merely
  // successful aggregate gates whose selected matrix may have been narrowed.
  if (inputs.mode !== "both") {
    throw new Error("Candidate-owned qualification requires mode=both");
  }
  if (
    profile !== "beta" &&
    ![undefined, "", false, "false"].includes(inputs.skip_package_telegram_e2e)
  ) {
    throw new Error("Candidate-owned stable/full qualification cannot skip Package Telegram E2E");
  }
  // Candidate-owned qualification has no implicit diagnostic-filter exception.
  for (const key of [
    "live_suite_filter",
    "cross_os_suite_filter",
    "release_package_spec",
    "npm_telegram_package_spec",
    "package_acceptance_package_spec",
    "codex_plugin_spec",
  ]) {
    if (inputs[key]) {
      throw new Error("Candidate-owned qualification cannot narrow " + key);
    }
  }
  if (
    inputs.allow_frozen_target_scenario_omissions === true ||
    inputs.allow_frozen_target_scenario_omissions === "true"
  ) {
    throw new Error("Candidate-owned qualification cannot omit frozen target scenarios");
  }
  const envelope = JSON.parse(String(inputs.trusted_workflow_json));
  for (const [label, patterns] of [
    ["Plugin Prerelease Node tests", inputs.plugin_prerelease_node_exclude_patterns_json],
    ["extension tests", envelope.laneInputs?.extension_test_exclude_patterns_json],
  ]) {
    const exclusions = JSON.parse(String(patterns || "[]"));
    if (!Array.isArray(exclusions) || exclusions.length !== 0) {
      throw new Error("Candidate-owned qualification cannot exclude " + label);
    }
  }
  const inventory = validateQualificationCoverage({
    schema: SCHEMA,
    profile,
    children: policy.children,
    requiredParentJobs: policy.requiredParentJobs,
  });
  const selected = names(policy.profiles[profile], "qualification profile children");
  const children = selected.map((key) => {
    const child = inventory.children.find((entry) => entry.key === key);
    if (!child) {
      throw new Error("Qualification profile names an unknown child: " + key);
    }
    return child;
  });
  return { ...inventory, children };
}

export function validateQualificationJobs(
  jobs,
  requiredNames,
  label = "Qualification",
  waivedJobNames = new Set(),
) {
  if (!Array.isArray(jobs)) {
    throw new Error(label + " job inventory is missing");
  }
  for (const name of names(requiredNames, "required job names")) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      (matches[0].conclusion !== "success" &&
        !(matches[0].conclusion === "failure" && waivedJobNames.has(name)))
    ) {
      throw new Error(label + " required job did not succeed exactly once: " + name);
    }
  }
}

// Read Q's declarative profile rows; never execute candidate code or substitute
// the current publisher's provider roster for the one the qualification ran.
function frozenProfileRows(source, name, profile) {
  const program = parseJavaScript(source, { sourceType: "module" }).program;
  const declaration = program.body
    .flatMap((node) => (node.type === "VariableDeclaration" ? node.declarations : []))
    .find((node) => node.id.type === "Identifier" && node.id.name === name);
  if (declaration?.init?.type !== "ArrayExpression") {
    throw new Error("Unsupported frozen qualification matrix: " + name);
  }
  const entries = declaration.init.elements.flatMap((entry) => {
    if (entry?.type !== "SpreadElement") {
      return [entry];
    }
    // Q's Docker install shards are a literal string array mapped to a literal
    // object. Read that bounded data shape, never execute the frozen module.
    const call = entry.argument;
    if (
      call.type !== "CallExpression" ||
      call.callee.type !== "MemberExpression" ||
      call.callee.object.type !== "ArrayExpression" ||
      call.callee.property.type !== "Identifier" ||
      call.callee.property.name !== "map" ||
      call.arguments.length !== 1
    ) {
      throw new Error("Unsupported frozen qualification matrix spread: " + name);
    }
    const mapper = call.arguments[0];
    if (
      mapper.type !== "ArrowFunctionExpression" ||
      mapper.params.length !== 1 ||
      mapper.params[0].type !== "Identifier" ||
      mapper.body.type !== "ObjectExpression"
    ) {
      throw new Error("Unsupported frozen qualification matrix mapper: " + name);
    }
    const variable = mapper.params[0].name;
    return call.callee.object.elements.map((value) => {
      if (value?.type !== "StringLiteral") {
        throw new Error("Unsupported frozen qualification matrix shard: " + name);
      }
      return {
        type: "ObjectExpression",
        properties: mapper.body.properties.map((property) => {
          if (property.type !== "ObjectProperty" || property.value.type !== "TemplateLiteral") {
            return property;
          }
          let text = property.value.quasis[0].value.cooked;
          for (const [index, expression] of property.value.expressions.entries()) {
            if (expression.type === "Identifier" && expression.name === variable) {
              text += value.value;
            } else if (
              expression.type === "CallExpression" &&
              expression.arguments.length === 0 &&
              expression.callee.type === "MemberExpression" &&
              expression.callee.object.type === "Identifier" &&
              expression.callee.object.name === variable &&
              expression.callee.property.type === "Identifier" &&
              expression.callee.property.name === "toUpperCase"
            ) {
              text += value.value.toUpperCase();
            } else {
              throw new Error("Unsupported frozen qualification shard label: " + name);
            }
            text += property.value.quasis[index + 1].value.cooked;
          }
          return {
            type: "ObjectProperty",
            key: property.key,
            value: { type: "StringLiteral", value: text },
          };
        }),
      };
    });
  });
  return entries.flatMap((entry) => {
    if (entry?.type !== "ObjectExpression") {
      throw new Error("Unsupported frozen qualification matrix row: " + name);
    }
    const fields = Object.fromEntries(
      entry.properties.flatMap((property) =>
        property.type === "ObjectProperty" &&
        property.key.type === "Identifier" &&
        property.value.type === "StringLiteral"
          ? [[property.key.name, property.value.value]]
          : [],
      ),
    );
    if (!fields.profiles) {
      throw new Error("Frozen qualification matrix has no profile: " + name);
    }
    return fields.profiles.split(/\s+/u).includes(profile) ? [fields] : [];
  });
}

/** Inputs are already bound to the authenticated admission and Q child receipt. */
export function qualificationRequiredChildJobs({ role, inputs, getSource, getCandidateFileNames }) {
  if (!role.startsWith("releaseChecks")) {
    return [];
  }
  const workflow = parseYaml(getSource(".github/workflows/openclaw-release-checks.yml"));
  const packageWorkflow = parseYaml(getSource(".github/workflows/package-acceptance.yml"));
  const liveWorkflow = parseYaml(
    getSource(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml"),
  );
  const jobName = (owner, key) => {
    const job = owner.jobs?.[key];
    if (!job) {
      throw new Error("Unsupported frozen qualification workflow job: " + key);
    }
    return job.name ?? key;
  };
  const selection = createReleaseCheckSelection({
    phase: inputs.phase,
    rerunGroup: inputs.rerun_group,
    runReleaseSoak: inputs.run_release_soak,
    repoLiveSuiteFilter: inputs.live_suite_filter,
  });
  const required = [];
  const matrixSource = getSource("scripts/plan-release-workflow-matrix.mjs");
  const baselines = JSON.parse(inputs.qualification_baselines_json || "{}");
  if (selection.install_smoke_scheduled) {
    const install = parseYaml(getSource(".github/workflows/install-smoke-reusable.yml"));
    const prefix = jobName(workflow, "install_smoke_release_checks") + " / ";
    for (const [key, job] of Object.entries(install.jobs)) {
      // Bun-only runtime is explicitly advisory; global-install smoke is not.
      if (job["continue-on-error"] === true) {
        continue;
      }
      if (
        job.strategy ||
        job.uses ||
        (job.if &&
          ![
            "always() && needs.preflight.result == 'success'",
            "needs.preflight.outputs.run_bun_global_install_smoke == 'true'",
          ].includes(job.if))
      ) {
        throw new Error("Unsupported frozen qualification install-smoke job: " + key);
      }
      required.push(prefix + jobName(install, key));
    }
  }
  if (selection.windows_node_scheduled) {
    // The external reusable workflow has a pinned, single-job contract, also
    // used by release-validation-waivers. Never borrow a moving remote roster.
    if (
      workflow.jobs.windows_node_stable_e2e?.uses !==
      "openclaw/openclaw-windows-node/.github/workflows/release-candidate-e2e.yml@76a48a68607d8cb7cc0ae607dbc46c920f07495a"
    ) {
      throw new Error("Unsupported frozen qualification Windows-node workflow");
    }
    required.push(
      jobName(workflow, "resolve_windows_node_release_artifacts"),
      jobName(workflow, "windows_node_stable_e2e") +
        " / Setup, connect, and invoke candidate gateway",
    );
  }
  if (selection.qa_live_scheduled) {
    if (inputs.live_suite_filter) {
      throw new Error("Unsupported frozen qualification narrowed QA-live selection");
    }
    const qa = parseYaml(getSource(".github/workflows/qa-live-transports-convex.yml"));
    for (const [parent, lane] of [
      ["qa_live_release_checks", "run_live_matrix"],
      ["qa_live_buzz_release_checks", "run_live_buzz"],
    ]) {
      const prefix = jobName(workflow, parent) + " / ";
      for (const key of ["authorize_actor", "validate_selected_ref", lane]) {
        required.push(prefix + jobName(qa, key));
      }
    }
    required.push(jobName(workflow, "qa_live_telegram_release_checks"));
    // Discord/WhatsApp/Slack permit status-artifact recovery. Their raw jobs
    // are not unconditional success gates, unlike Matrix, Buzz and Telegram.
  }
  if (selection.qa_parity_scheduled) {
    const job = workflow.jobs.qa_lab_runtime_pair_lane_release_checks;
    const lanes = [...String(job?.strategy?.matrix?.lane).matchAll(/'([^']+)'/gu)]
      .map((match) => match[1])
      .filter((value) => value.startsWith("["));
    if (lanes.length !== 2) {
      throw new Error("Unsupported frozen qualification runtime-pair matrix");
    }
    for (const lane of JSON.parse(lanes[inputs.run_release_soak === "true" ? 0 : 1])) {
      required.push(
        jobName(workflow, "qa_lab_runtime_pair_lane_release_checks").replace(
          "${{ matrix.lane }}",
          lane,
        ),
      );
    }
    required.push(jobName(workflow, "runtime_tool_coverage_release_checks"));
    // Parity reports and the runtime aggregate may be recovered from trusted
    // status artifacts. Do not convert their raw advisory failures into gates.
  }
  if (selection.cross_os_scheduled) {
    const crossSource = getSource("scripts/lib/cross-os-release-checks/config.ts");
    const baseline = /const node24Version = "([0-9.]+)";/u.exec(crossSource)?.[1];
    const versions = /\? \[node24Version, "([0-9.]+)"\]/u.exec(crossSource)?.[1];
    // Pre-expansion Q has one unsuffixed job per logical lane. Unknown expanded
    // layouts require a source adapter, not today's P Node-version matrix.
    if (
      (crossSource.includes("const nodeVersions") || crossSource.includes("node_version:")) &&
      (!baseline || !versions)
    ) {
      throw new Error("Unsupported frozen qualification cross-OS Node matrix");
    }
    const matrix = resolveRunnerMatrix({
      mode: inputs.mode,
      ref: inputs.target_context_ref || inputs.ref,
    });
    const logical = new Map(
      matrix.include.map((row) => [
        row.os_id + ":" + row.suite,
        { ...row, suite_label: row.suite_label.replace(/ \(Node [^)]+\)$/u, "") },
      ]),
    );
    for (const row of logical.values()) {
      if (
        !crossSource.includes('"' + row.suite + '"') ||
        !crossSource.includes('display_name: "' + row.display_name + '"')
      ) {
        throw new Error("Unsupported frozen qualification cross-OS suite: " + row.suite);
      }
      const name =
        jobName(workflow, "cross_os_release_checks") +
        " / " +
        row.display_name +
        " / " +
        row.suite_label;
      required.push(name);
      if (versions && ["packaged-fresh", "packaged-upgrade"].includes(row.suite)) {
        required.push(name + " (Node " + versions + ")");
      }
    }
  }
  if (selection.package_acceptance_scheduled) {
    // Until a frozen adapter supports another planner policy, fail closed on
    // Q/P divergence rather than silently using P recovery pins/support floors
    // or lane expansion. First-hop inventory is already expanded from Q below.
    for (const path of [
      "scripts/plan-targeted-docker-lane-groups.mjs",
      "scripts/lib/upgrade-survivor-policy.mjs",
      "scripts/lib/upgrade-survivor-scenarios.json",
      "scripts/lib/update-first-hop-lanes.mjs",
      "scripts/e2e/lib/upgrade-survivor/installed-recovery-cases.mjs",
      "scripts/lib/release-version.mjs",
      "scripts/lib/numeric-options.mjs",
    ]) {
      if (getSource(path) !== readFileSync(new URL("../" + path, import.meta.url), "utf8")) {
        throw new Error("Unsupported frozen qualification Docker policy: " + path);
      }
    }
    const prefix = jobName(workflow, "package_acceptance_release_checks") + " / ";
    for (const key of ["resolve_package", "package_integrity", "npm_12_install_sh", "summary"]) {
      required.push(prefix + jobName(packageWorkflow, key));
    }
    const lanes = /export const RELEASE_PACKAGE_ACCEPTANCE_LANES =\s*"([^"]+)"/u.exec(
      matrixSource,
    )?.[1];
    if (!lanes) {
      throw new Error("Unsupported frozen qualification package lane selection");
    }
    const inventory = JSON.parse(getSource("scripts/lib/update-compat-inventory.json"));
    const expandedLanes = lanes
      .split(/\s+/u)
      .flatMap((lane) =>
        lane === "update-first-hop-compat"
          ? inventory.releases
              .map((release) => lane + "-" + release.version)
              .concat(lane + "-missing-load-path")
          : [lane],
      );
    // The Q workflow selects scenarios using Q's catalog and explicit exclusions.
    // Passing these literal scenarios avoids expanding P's evolving alias roster.
    const scenarioPolicy = getSource("scripts/lib/upgrade-survivor-policy.mjs");
    const aggregate =
      /const aggregateScenarios = UPGRADE_SURVIVOR_SCENARIOS\.filter\(([\s\S]*?)\n\);/u.exec(
        scenarioPolicy,
      )?.[1];
    if (!aggregate) {
      throw new Error("Unsupported frozen qualification survivor scenario selection");
    }
    const exclusions = new Set(
      [...aggregate.matchAll(/scenario !== "([^"]+)"/gu)].map((match) => match[1]),
    );
    const catalog = JSON.parse(getSource("scripts/lib/upgrade-survivor-scenarios.json"));
    const artifact = JSON.parse(inputs.candidate_artifact_json || "{}");
    const candidateVersion = parseReleaseVersion(artifact.packageVersion);
    const workflowVersion = parseReleaseVersion(JSON.parse(getSource("package.json")).version);
    if (!candidateVersion || !workflowVersion) {
      throw new Error("Invalid frozen qualification survivor package version");
    }
    const currentLine =
      artifact.packagePublished !== true &&
      !inputs.package_acceptance_package_spec &&
      !String(inputs.target_context_ref)
        .replace(/^refs\/heads\//u, "")
        .startsWith("extended-stable/") &&
      !String(inputs.ref)
        .replace(/^refs\/heads\//u, "")
        .startsWith("extended-stable/") &&
      compareReleaseVersions(candidateVersion.baseVersion, workflowVersion.baseVersion) >= 0;
    // Q owns the policy, but the original workflow probes capabilities at C.
    // Missing individual fixtures deliberately retain the older scenario roster.
    const candidateFiles = currentLine ? getCandidateFileNames(artifact.packageSourceSha) : [];
    const supportsOperator = candidateFiles.includes("legacy-operator-state.mjs");
    const supportsSibling = candidateFiles.includes("custom-plugin-siblings.mjs");
    const supportsRecovery = candidateFiles.includes("package-activation-recovery.mjs");
    const scenarios = (
      inputs.run_release_soak === "true"
        ? catalog.scenarios.filter(
            (scenario) => !exclusions.has(scenario) && scenario !== "sqlite-volume",
          )
        : ["base", "legacy-operator-state", "custom-plugin-siblings"]
    )
      .filter((scenario) => !isPackageRecoveryScenario(scenario) || supportsRecovery)
      .filter((scenario) => scenario !== "legacy-operator-state" || supportsOperator)
      .filter((scenario) => scenario !== "custom-plugin-siblings" || supportsSibling);
    for (const group of planTargetedDockerLaneGroups({
      lanes: expandedLanes.join(" "),
      upgradeSurvivorBaseline: baselines.upgradeBaseline,
      upgradeSurvivorBaselines: (baselines.upgradeSurvivorBaselines || []).join(" "),
      upgradeSurvivorScenarios: scenarios.join(" "),
    })) {
      required.push(
        prefix +
          jobName(packageWorkflow, "docker_acceptance") +
          " / " +
          jobName(liveWorkflow, "validate_docker_lanes").replace(
            "${{ matrix.group.label }}",
            group.label,
          ),
      );
    }
    if (inputs.skip_package_telegram_e2e !== "true") {
      const telegram = parseYaml(getSource(".github/workflows/npm-telegram-beta-e2e.yml"));
      required.push(
        prefix +
          jobName(packageWorkflow, "package_telegram") +
          " / " +
          jobName(telegram, "run_package_telegram_e2e"),
      );
    }
  }
  if (selection.docker_required) {
    const prefix = jobName(workflow, "docker_e2e_release_checks") + " / ";
    for (const row of frozenProfileRows(
      matrixSource,
      "DOCKER_E2E_CHUNKS",
      inputs.release_profile,
    )) {
      const labels =
        row.chunk_id === "package-update-migrations" &&
        baselines.upgradeSurvivorBaselines?.length > 1
          ? [
              "package/update channel switching",
              ...baselines.upgradeSurvivorBaselines.map(
                (baseline) => "package/update migration " + baseline,
              ),
            ]
          : [row.label];
      for (const label of labels) {
        required.push(
          prefix +
            jobName(liveWorkflow, "validate_docker_e2e").replace("${{ matrix.label }}", label),
        );
      }
    }
    if (inputs.release_profile !== "beta") {
      required.push(prefix + jobName(liveWorkflow, "validate_docker_openwebui"));
    }
  }
  if (selection.live_e2e_scheduled) {
    const source = matrixSource;
    const prefix = jobName(workflow, "live_repo_e2e_release_checks") + " / ";
    for (const [matrix, key, field, operand] of [
      ["LIVE_DOCKER_SUITES", "validate_live_docker_provider_suites", "label", "matrix.label"],
      [
        "LIVE_MODEL_PROVIDERS",
        "validate_live_models_docker",
        "provider_label",
        "matrix.provider_label",
      ],
    ]) {
      const template = jobName(liveWorkflow, key);
      for (const row of frozenProfileRows(source, matrix, inputs.release_profile)) {
        if (!row[field] || !template.includes("${{ " + operand + " }}")) {
          throw new Error("Unsupported frozen qualification matrix job: " + matrix);
        }
        required.push(prefix + template.replace("${{ " + operand + " }}", row[field]));
      }
    }
    for (const key of ["validate_live_provider_suites", "validate_live_media_provider_suites"]) {
      const job = liveWorkflow.jobs[key];
      const template = jobName(liveWorkflow, key).replace(
        "${{ inputs.test_runtime == 'bun' && ' (Bun advisory)' || '' }}",
        "",
      );
      for (const row of job.strategy.matrix.include) {
        if (row.profiles.split(/\s+/u).includes(inputs.release_profile)) {
          required.push(prefix + template.replace("${{ matrix.label }}", row.label));
        }
      }
    }
  }
  return required;
}

export function validateQualificationChildCompleteness({ jobs, waivedJobNames, ...context }) {
  const required = qualificationRequiredChildJobs(context);
  if (required.length) {
    validateQualificationJobs(jobs, required, "Qualification " + context.role, waivedJobNames);
  }
}
