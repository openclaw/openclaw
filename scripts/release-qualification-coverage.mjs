import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalAsciiJson, compareAscii } from "./lib/canonical-json.mjs";
import { isRecord } from "./lib/record-shared.mjs";

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
  object(value, ["schema", "profile", "children", "requiredParentJobs"], "qualification coverage");
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
  // The release policy separately validates the exact owner-approved Telegram
  // declaration. It does not remove the Telegram child or any required job
  // from this frozen qualification inventory.
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

export function validateQualificationJobs(jobs, requiredNames, label = "Qualification") {
  if (!Array.isArray(jobs)) {
    throw new Error(label + " job inventory is missing");
  }
  for (const name of names(requiredNames, "required job names")) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    ) {
      throw new Error(label + " required job did not succeed exactly once: " + name);
    }
  }
}
