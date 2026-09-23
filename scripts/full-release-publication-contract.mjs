import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPreparedClawHubTrustedPublisher } from "./clawhub-prepared-artifact.mjs";
import { canonicalizeJsonValue, compareAscii } from "./lib/canonical-json.mjs";
import corePackages from "./lib/npm-core-release-packages.json" with { type: "json" };
import { resolveNpmPublishPlan } from "./lib/npm-publish-plan.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "./lib/release-version.mjs";

export const FULL_RELEASE_SOURCE_ADMISSION_CONTRACT = "1";
export const FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT = "1";
const purposes = ["publish", "diagnostic", "main-qualification", "postpublish-confidence"];
const maximumBytes = 128 * 1024;
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const packageName = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const coverageInputs = {
  provider: "provider",
  mode: "mode",
  live_suite_filter: "liveSuiteFilter",
  cross_os_suite_filter: "crossOsSuiteFilter",
  release_package_spec: "releasePackageSpec",
  package_acceptance_package_spec: "packageAcceptancePackageSpec",
  codex_plugin_spec: "codexPluginSpec",
  npm_telegram_package_spec: "npmTelegramPackageSpec",
  npm_telegram_provider_mode: "npmTelegramProviderMode",
  npm_telegram_scenario: "npmTelegramScenario",
  plugin_prerelease_node_exclude_patterns_json: "pluginPrereleaseNodeExcludePatternsJson",
  extension_test_exclude_patterns_json: "extensionTestExcludePatternsJson",
  skip_package_telegram_e2e: "skipPackageTelegramE2e",
  telegram_waiver: "telegramWaiver",
  allow_unreleased_changelog: "allowUnreleasedChangelog",
};

// This marker belongs to the top-level workflow env, not artifact-controlled data.
export function publicationSourceContract(workflowSource) {
  if (typeof workflowSource !== "string" || Buffer.byteLength(workflowSource) > 1024 * 1024) {
    throw new Error("missing or oversized source-admission workflow contract");
  }
  const matches = [
    ...workflowSource.matchAll(/^ {2}FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: *([^\r\n]+)$/gmu),
  ];
  if (!matches.length) {
    if (workflowSource.includes("FULL_RELEASE_SOURCE_ADMISSION_CONTRACT")) {
      throw new Error("unrecognized source-admission workflow contract encoding");
    }
    return undefined;
  }
  if (matches.length !== 1 || !/^(?:"1"|'1'|1)$/u.test(matches[0][1])) {
    throw new Error("unsupported source-admission workflow contract");
  }
  return FULL_RELEASE_SOURCE_ADMISSION_CONTRACT;
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
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new Error(`invalid ${label}`);
    }
  }
  return value;
}

export function publicationSourceJson(value) {
  const json = JSON.stringify(canonicalizeJsonValue(value));
  if (Buffer.byteLength(json) > maximumBytes) {
    throw new Error("source admission exceeds byte limit");
  }
  return json;
}

function publicationSourceDigest(value) {
  return createHash("sha256").update(publicationSourceJson(value)).digest("hex");
}

export function normalizePublicationIntent(purpose, selectionJson = "") {
  if (!purposes.includes(purpose)) {
    throw new Error(`validation_purpose must be explicit: ${purposes.join(", ")}`);
  }
  if (purpose !== "publish") {
    if (selectionJson !== "") {
      throw new Error("nonpublish purpose must omit publication selection");
    }
    return { validationPurpose: purpose, publicationSelection: null };
  }
  if (
    typeof selectionJson !== "string" ||
    !selectionJson ||
    Buffer.byteLength(selectionJson) > 16 * 1024
  ) {
    throw new Error("publish purpose requires bounded publication_selection_json");
  }
  let selected;
  try {
    selected = JSON.parse(selectionJson);
  } catch {
    throw new Error("invalid publication selection JSON");
  }
  object(
    selected,
    [
      "route",
      "npmDistTag",
      "publishOpenclawNpm",
      "pluginPublishScope",
      "plugins",
      "windowsNodeTag",
      "windowsNodeInstallerDigests",
    ],
    "publication selection",
  );
  if (
    !["normal", "prepared", "extended-stable", "alpha"].includes(selected.route) ||
    !["alpha", "beta", "latest", "extended-stable"].includes(selected.npmDistTag) ||
    typeof selected.publishOpenclawNpm !== "boolean" ||
    !["selected", "all-publishable"].includes(selected.pluginPublishScope) ||
    !Array.isArray(selected.plugins) ||
    selected.plugins.length > 256 ||
    selected.plugins.some((name) => typeof name !== "string" || !packageName.test(name))
  ) {
    throw new Error("invalid publication selection operands");
  }
  const plugins = [...new Set(selected.plugins)].toSorted(compareAscii);
  if ((selected.pluginPublishScope === "selected") !== plugins.length > 0) {
    throw new Error("selected publication requires names; all-publishable must omit names");
  }
  if (selected.publishOpenclawNpm && selected.pluginPublishScope !== "all-publishable") {
    throw new Error("core publication requires all-publishable plugins");
  }
  if (
    (selected.route === "extended-stable") !== (selected.npmDistTag === "extended-stable") ||
    (selected.route === "alpha") !== (selected.npmDistTag === "alpha")
  ) {
    throw new Error("publication route and npm dist-tag disagree");
  }
  if (
    ["prepared", "extended-stable"].includes(selected.route) &&
    (selected.pluginPublishScope !== "all-publishable" || !selected.publishOpenclawNpm)
  ) {
    throw new Error("prepared and extended-stable require the complete core/plugin publication");
  }
  const windows = {};
  if (selected.windowsNodeTag !== undefined || selected.windowsNodeInstallerDigests !== undefined) {
    if (selected.route === "extended-stable") {
      throw new Error("extended-stable does not select Windows assets");
    }
    if (!["beta", "latest"].includes(selected.npmDistTag)) {
      throw new Error("Windows assets require a stable publication");
    }
    windows.windowsNodeTag = text(selected.windowsNodeTag, "Windows source tag", 256);
    if (
      !/^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u.test(
        windows.windowsNodeTag,
      )
    ) {
      throw new Error("invalid Windows source tag");
    }
    const digests = selected.windowsNodeInstallerDigests;
    if (
      !digests ||
      typeof digests !== "object" ||
      Array.isArray(digests) ||
      !Object.keys(digests).length ||
      Object.keys(digests).length > 16 ||
      Object.entries(digests).some(
        ([name, value]) =>
          !/^[A-Za-z0-9._-]+$/u.test(name) ||
          typeof value !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(value),
      )
    ) {
      throw new Error("invalid Windows installer digest map");
    }
    windows.windowsNodeInstallerDigests = digests;
  }
  return {
    validationPurpose: purpose,
    publicationSelection: {
      route: selected.route,
      npmDistTag: selected.npmDistTag,
      publishOpenclawNpm: selected.publishOpenclawNpm,
      pluginPublishScope: selected.pluginPublishScope,
      plugins,
      ...windows,
    },
  };
}

export function publicationIntentInputs(intent) {
  const normalized = normalizePublicationIntent(
    intent.validationPurpose,
    intent.publicationSelection === null ? "" : publicationSourceJson(intent.publicationSelection),
  );
  return {
    validationPurpose: normalized.validationPurpose,
    publicationSelectionJson:
      normalized.publicationSelection === null
        ? ""
        : publicationSourceJson(normalized.publicationSelection),
  };
}

export function normalizePublicationLaneInputs(value) {
  object(value, ["extension_test_exclude_patterns_json"], "source-admission lane inputs");
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      if (typeof raw !== "string" || raw.length > 4096) {
        throw new Error(`invalid ${key}`);
      }
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
        throw new Error(`${key} must be a JSON array of strings`);
      }
      return [key, JSON.stringify(entries)];
    }),
  );
}

export function decodePublicationDispatchEnvelope(raw) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > maximumBytes) {
    throw new Error("trusted_workflow_json requires a bounded source-admission envelope");
  }
  const value = object(
    JSON.parse(raw),
    ["trustedWorkflow", "validationPurpose", "publicationSelection", "laneInputs"],
    "source-admission envelope",
  );
  if (
    ["trustedWorkflow", "validationPurpose", "publicationSelection"].some(
      (key) => !Object.hasOwn(value, key),
    )
  ) {
    throw new Error("source-admission envelope requires identity, purpose and selection");
  }
  const trustedWorkflow = value.trustedWorkflow;
  if (trustedWorkflow !== null) {
    object(trustedWorkflow, ["ref", "fullRef", "sha"], "source-admission tooling identity");
    if (
      Object.keys(trustedWorkflow).length !== 3 ||
      typeof trustedWorkflow.ref !== "string" ||
      !/^[A-Za-z0-9._/-]+$/u.test(trustedWorkflow.ref) ||
      !["refs/heads/", "refs/tags/"].some(
        (prefix) => trustedWorkflow.fullRef === prefix + trustedWorkflow.ref,
      ) ||
      typeof trustedWorkflow.sha !== "string" ||
      !sha.test(trustedWorkflow.sha)
    ) {
      throw new Error("invalid source-admission tooling identity");
    }
  }
  const laneInputs =
    value.laneInputs === undefined ? undefined : normalizePublicationLaneInputs(value.laneInputs);
  return {
    trustedWorkflow,
    ...(laneInputs === undefined ? {} : { laneInputs }),
    ...normalizePublicationIntent(
      value.validationPurpose,
      value.publicationSelection === null ? "" : publicationSourceJson(value.publicationSelection),
    ),
  };
}

export function publicationDispatchEnvelope(trustedWorkflow, intent, laneInputs) {
  return publicationSourceJson(
    decodePublicationDispatchEnvelope(
      publicationSourceJson({ trustedWorkflow, ...intent, ...(laneInputs ? { laneInputs } : {}) }),
    ),
  );
}

function dispatchEnvelopeFromInputs(inputs) {
  if (
    Object.hasOwn(inputs, "validation_purpose") ||
    Object.hasOwn(inputs, "publication_selection_json") ||
    Object.hasOwn(inputs, "extension_test_exclude_patterns_json")
  ) {
    throw new Error("source intent must use only the trusted_workflow_json envelope");
  }
  return decodePublicationDispatchEnvelope(inputs.trusted_workflow_json);
}

export function publicationSourceRequest(env) {
  const inputs = JSON.parse(env.PUBLICATION_INPUTS_JSON);
  const { trustedWorkflow, laneInputs, ...intent } = dispatchEnvelopeFromInputs(inputs);
  const coverageSource = { ...inputs, extension_test_exclude_patterns_json: "[]", ...laneInputs };
  const tooling = JSON.parse(env.PUBLICATION_TOOLING_JSON);
  if (
    trustedWorkflow &&
    ["ref", "fullRef", "sha"].some((key) => trustedWorkflow[key] !== tooling[key])
  ) {
    throw new Error("source-admission tooling differs from resolved identity");
  }
  const coverage = {};
  for (const key of [
    ...Object.keys(coverageInputs),
    "release_profile",
    "rerun_group",
    "evidence_package_spec",
    "fail_fast",
    "dispatch_release_evidence",
  ]) {
    coverage[key] = text(String(coverageSource[key] ?? ""), key);
  }
  coverage.live_suite_filter = env.PUBLICATION_LIVE_FILTER ?? coverage.live_suite_filter;
  coverage.cross_os_suite_filter =
    env.PUBLICATION_CROSS_OS_FILTER ?? coverage.cross_os_suite_filter;
  coverage.skip_package_telegram_e2e =
    env.PUBLICATION_SKIP_TELEGRAM ?? coverage.skip_package_telegram_e2e;
  coverage.allow_unreleased_changelog = String(
    inputs.allow_unreleased_changelog === true ||
      inputs.allow_unreleased_changelog === "true" ||
      (!inputs.target_context_ref && ["main", "refs/heads/main"].includes(inputs.ref)),
  );
  coverage.run_release_soak = String(
    inputs.run_release_soak === true ||
      inputs.run_release_soak === "true" ||
      ["stable", "full"].includes(inputs.release_profile),
  );
  coverage.coverage_policy = text(env.PUBLICATION_COVERAGE_POLICY ?? "", "coverage policy");
  return {
    repository: env.GITHUB_REPOSITORY,
    candidateSha: env.PUBLICATION_TARGET_SHA,
    targetContextRef: text(env.PUBLICATION_TARGET_CONTEXT || inputs.ref, "target context"),
    tooling: { ref: tooling.fullRef, sha: tooling.sha },
    workflow: { ref: env.GITHUB_REF, sha: env.GITHUB_SHA },
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    ...intent,
    coverage,
  };
}

export function createPublicationSourceFact(request, inventory, projection) {
  const fact = {
    kind: "openclaw.full-release-source-admission/v1",
    contract: FULL_RELEASE_SOURCE_ADMISSION_CONTRACT,
    ...request,
    status: request.validationPurpose === "publish" ? "source-admitted" : "not-applicable",
    inventoryDigest: inventory === null ? null : publicationSourceDigest(inventory),
    projection,
  };
  const result = { ...fact, digest: publicationSourceDigest(fact) };
  return validatePublicationSourceFact(result);
}

function validatePublicationSourceFact(value, expected = {}) {
  object(
    value,
    [
      "kind",
      "contract",
      "repository",
      "candidateSha",
      "targetContextRef",
      "tooling",
      "workflow",
      "runId",
      "runAttempt",
      "validationPurpose",
      "publicationSelection",
      "coverage",
      "status",
      "inventoryDigest",
      "projection",
      "digest",
    ],
    "source admission fact",
  );
  if (
    value.kind !== "openclaw.full-release-source-admission/v1" ||
    value.contract !== FULL_RELEASE_SOURCE_ADMISSION_CONTRACT ||
    value.repository !== "openclaw/openclaw" ||
    !sha.test(value.candidateSha) ||
    !/^[1-9][0-9]*$/u.test(value.runId) ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt < 1
  ) {
    throw new Error("invalid source admission identity");
  }
  text(value.targetContextRef, "source target context");
  for (const identity of [value.tooling, value.workflow]) {
    object(identity, ["ref", "sha"], "source tooling/workflow identity");
    if (
      !sha.test(identity.sha) ||
      !/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(identity.ref)
    ) {
      throw new Error("invalid source tooling/workflow identity");
    }
  }
  if (value.tooling.sha !== value.workflow.sha) {
    throw new Error("source tooling differs from executed workflow");
  }
  const intent = publicationIntentInputs(value);
  const coverageKeys = [
    ...Object.keys(coverageInputs),
    "release_profile",
    "rerun_group",
    "evidence_package_spec",
    "fail_fast",
    "dispatch_release_evidence",
    "run_release_soak",
    "coverage_policy",
  ];
  object(value.coverage, coverageKeys, "source admission coverage");
  if (
    coverageKeys.some(
      (key) =>
        key !== "extension_test_exclude_patterns_json" && !Object.hasOwn(value.coverage, key),
    )
  ) {
    throw new Error("source admission coverage is incomplete");
  }
  for (const entry of Object.values(value.coverage)) {
    text(entry, "source admission coverage");
  }
  if (value.validationPurpose === "publish") {
    if (value.status !== "source-admitted" || !digest.test(value.inventoryDigest)) {
      throw new Error("publish source admission requires verified complete inventory");
    }
    object(value.projection, ["version", "packages", "platforms"], "publication source projection");
    text(value.projection.version, "projection version", 128);
    const version = parseReleaseVersion(value.projection.version);
    if (!version) {
      throw new Error("invalid projection version");
    }
    if (!Array.isArray(value.projection.packages) || !Array.isArray(value.projection.platforms)) {
      throw new Error("invalid publication source projection");
    }
    if (
      (value.publicationSelection.windowsNodeTag ||
        value.projection.platforms.some((entry) => entry?.id === "windows")) &&
      classifyReleaseTrain(version) !== "stable"
    ) {
      throw new Error("Windows assets require a stable publication");
    }
    for (const [entries, name] of [
      [value.projection.packages, "name"],
      [value.projection.platforms, "id"],
    ]) {
      if (
        entries.length > 512 ||
        new Set(entries.map((entry) => entry?.[name])).size !== entries.length
      ) {
        throw new Error("duplicate or oversized publication source projection");
      }
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          !text(entry[name], "projection identity", 256)
        ) {
          throw new Error("invalid publication source projection entry");
        }
        if (name === "name") {
          object(entry, ["name", "version", "targets"], "publication package projection");
          if (
            !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(entry.name) ||
            typeof entry.version !== "string" ||
            !parseReleaseVersion(entry.version) ||
            !Array.isArray(entry.targets) ||
            entry.targets.length === 0 ||
            entry.targets.some((target) => !["npm", "clawhub"].includes(target)) ||
            JSON.stringify(entry.targets) !==
              JSON.stringify([...new Set(entry.targets)].toSorted(compareAscii))
          ) {
            throw new Error("invalid publication package version or targets");
          }
        } else {
          object(entry, ["id", "source"], "publication platform projection");
          if (
            !/^[a-z][a-z0-9-]*$/u.test(entry.id) ||
            typeof entry.source !== "string" ||
            !/^\.github\/workflows\/[a-z0-9][a-z0-9-]*\.yml$/u.test(entry.source)
          ) {
            throw new Error("invalid publication platform source");
          }
        }
      }
      if (entries.some((entry, index) => index > 0 && entries[index - 1][name] >= entry[name])) {
        throw new Error("publication projection must retain canonical ordering");
      }
    }
  } else if (
    value.status !== "not-applicable" ||
    value.inventoryDigest !== null ||
    value.projection !== null
  ) {
    throw new Error("nonpublish source admission must be not-applicable");
  }
  const { digest: actualDigest, ...content } = value;
  if (!digest.test(actualDigest) || actualDigest !== publicationSourceDigest(content)) {
    throw new Error("source admission digest mismatch");
  }
  const bindings = {
    repository: value.repository,
    targetSha: value.candidateSha,
    targetContextRef: value.targetContextRef,
    trustedWorkflowFullRef: value.tooling.ref,
    trustedWorkflowSha: value.tooling.sha,
    parentRunId: value.runId,
    sourceParentRunAttempt: value.runAttempt,
    workflowSha: value.workflow.sha,
    workflowRef: value.workflow.ref.replace(/^refs\/(?:heads|tags)\//u, ""),
    releaseProfile: value.coverage.release_profile,
    rerunGroup: value.coverage.rerun_group,
    runReleaseSoak: value.coverage.run_release_soak,
    ...intent,
  };
  for (const [key, wanted] of Object.entries(expected)) {
    if (
      wanted !== undefined &&
      Object.hasOwn(bindings, key) &&
      String(bindings[key]) !== String(wanted)
    ) {
      throw new Error(`source admission ${key} mismatch`);
    }
  }
  return value;
}

export function validatePublicationSourceBinding(record, expected = {}) {
  const contract = record.sourceAdmissionContract;
  if (
    expected.sourceAdmissionContract !== undefined &&
    contract !== expected.sourceAdmissionContract
  ) {
    throw new Error("source admission contract missing or mismatched");
  }
  if (contract === undefined) {
    if (
      record.sourceAdmission !== undefined ||
      record.validationInputs?.validationPurpose !== undefined ||
      record.validationInputs?.publicationSelectionJson !== undefined
    ) {
      throw new Error("source admission omitted its workflow contract");
    }
    return undefined;
  }
  if (contract !== FULL_RELEASE_SOURCE_ADMISSION_CONTRACT) {
    throw new Error("unsupported source admission contract");
  }
  if (record.runId !== undefined && (!record.validationInputs || !record.trustedWorkflow)) {
    throw new Error("source admission manifest omitted its inputs or canonical tooling identity");
  }
  const fact = validatePublicationSourceFact(record.sourceAdmission, {
    targetSha: record.targetSha,
    parentRunId: record.runId ?? record.parentRunId,
    workflowSha: record.workflowSha,
    workflowRef: record.workflowRef,
    sourceParentRunAttempt: record.sourceParentRunAttempt ?? record.parentRunAttempt,
    releaseProfile: record.releaseProfile,
    rerunGroup: record.rerunGroup,
    runReleaseSoak: record.runReleaseSoak,
    ...(record.trustedWorkflow
      ? {
          trustedWorkflowFullRef: record.trustedWorkflow.fullRef,
          trustedWorkflowSha: record.trustedWorkflow.sha,
        }
      : {}),
    ...expected,
  });
  if (record.validationInputs) {
    const context = record.validationInputs.targetContextRef || record.targetRef;
    if (context !== fact.targetContextRef) {
      throw new Error("source admission target context differs from manifest");
    }
    const intent = publicationIntentInputs(fact);
    for (const [key, value] of Object.entries(intent)) {
      if (record.validationInputs[key] !== value) {
        throw new Error(`source admission ${key} differs from manifest`);
      }
    }
    for (const [input, key] of Object.entries(coverageInputs)) {
      const historicalDefault = input === "extension_test_exclude_patterns_json" ? "[]" : "";
      if (
        String(record.validationInputs[key] ?? historicalDefault) !==
        (fact.coverage[input] ?? historicalDefault)
      ) {
        throw new Error(`source admission coverage ${key} differs from manifest`);
      }
    }
    if ((record.validationInputs.coveragePolicy ?? "") !== fact.coverage.coverage_policy) {
      throw new Error("source admission coverage policy differs from manifest");
    }
  }
  return fact;
}

export function publicationSourceReuseIdentity(fact) {
  if (fact === undefined) {
    return undefined;
  }
  validatePublicationSourceFact(fact);
  return {
    validationPurpose: fact.validationPurpose,
    publicationSelection: fact.publicationSelection,
    inventoryDigest: fact.inventoryDigest,
    projection: fact.projection,
  };
}

export function publicationAdmissionContract(workflowSource) {
  if (typeof workflowSource !== "string" || Buffer.byteLength(workflowSource) > 1024 * 1024) {
    throw new Error("missing or oversized publication-admission workflow contract");
  }
  const matches = [
    ...workflowSource.matchAll(/^ {2}FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: *([^\r\n]+)$/gmu),
  ];
  if (!matches.length && !workflowSource.includes("FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT")) {
    return undefined;
  }
  if (matches.length !== 1 || !/^(?:"1"|'1'|1)$/u.test(matches[0][1])) {
    throw new Error("unsupported publication-admission workflow contract");
  }
  return FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT;
}

function closedObject(value, keys, label) {
  object(value, keys, label);
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`incomplete ${label}`);
  }
  return value;
}

function observationTime(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("invalid publication observation time");
  }
  return time;
}

// These exact canonical bytes are uploaded once; their digest is not the ZIP digest.
export function publicationObservationJson(value) {
  return `${JSON.stringify(canonicalizeJsonValue(value))}\n`;
}

function observationDigest(observations) {
  return `sha256:${createHash("sha256").update(publicationObservationJson(observations)).digest("hex")}`;
}

function observationNames(rows, label, maximum = 1024) {
  if (
    !Array.isArray(rows) ||
    rows.length > maximum ||
    rows.some(
      (row, index) =>
        !row ||
        typeof row.name !== "string" ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(row.name) ||
        row.name.length > 256 ||
        (index > 0 && compareAscii(rows[index - 1].name, row.name) >= 0),
    )
  ) {
    throw new Error(`invalid publication ${label} roster`);
  }
}

function validateObservationPlan(plan, registry, required, observations) {
  const groups =
    registry === "npm"
      ? ["candidates", "skippedPublished"]
      : ["candidates", "skippedPublished", "bootstrapCandidates", "missingTrustedPublisher"];
  closedObject(plan, ["all", ...groups, "warnings"], "publication planning summary");
  observationNames(plan.all, "planning", 512);
  for (const entry of plan.all) {
    closedObject(entry, ["name", "version", "alreadyPublished"], "publication planning entry");
    if (
      !required.some((row) => row.name === entry.name && row.version === entry.version) ||
      typeof entry.alreadyPublished !== "boolean"
    ) {
      throw new Error("publication planning entry differs from selected registry roster");
    }
  }
  if (registry === "clawhub" && plan.all.length !== required.length) {
    throw new Error("publication ClawHub planning roster is incomplete");
  }
  for (const group of groups) {
    if (
      !Array.isArray(plan[group]) ||
      new Set(plan[group]).size !== plan[group].length ||
      plan[group].some((name) => !plan.all.some((entry) => entry.name === name))
    ) {
      throw new Error("invalid publication planning group");
    }
  }
  for (const entry of plan.all) {
    const observed = observations.find((row) => row.name === entry.name)?.state;
    const published =
      registry === "npm" ? observed?.selectedVersionExists : observed?.alreadyPublished;
    const candidate =
      !published &&
      (registry === "npm" || (observed?.packageExists && observed?.hasTrustedPublisher));
    if (
      entry.alreadyPublished !== published ||
      plan.skippedPublished.includes(entry.name) !== entry.alreadyPublished ||
      plan.candidates.includes(entry.name) !== candidate ||
      (registry === "clawhub" &&
        (plan.bootstrapCandidates.includes(entry.name) !== !observed.packageExists ||
          plan.missingTrustedPublisher.includes(entry.name) !==
            (observed.packageExists && !observed.hasTrustedPublisher)))
    ) {
      throw new Error("publication planning outcome mismatch");
    }
  }
  if (!Array.isArray(plan.warnings) || plan.warnings.length > 4096) {
    throw new Error("invalid publication advisory warnings");
  }
  for (const warning of plan.warnings) {
    text(warning, "publication advisory warning");
  }
}

// The worker and retained-receipt reader use the same state-to-authority decision.
// Package membership/version is the authenticated A projection, not caller input.
export function publicationPendingAuthority(source, registry, row) {
  const selected = source.projection?.packages.find(
    (entry) =>
      entry.name === row.name && entry.version === row.version && entry.targets.includes(registry),
  );
  if (!selected || !source.publicationSelection) {
    throw new Error("publication authority requires a selected source package");
  }
  const selection = source.publicationSelection;
  let action;
  if (registry === "npm") {
    if (row.state.packageExists) {
      if (!row.state.hasVersionHistory) {
        throw new Error(`${row.name}: npm HTTP 200 has empty version history.`);
      }
      return null;
    }
    const parsed = parseReleaseVersion(selected.version);
    const plugin =
      packageName.test(selected.name) && !corePackages.some((entry) => entry.name === selected.name)
        ? resolveNpmPublishPlan(
            selected.version,
            undefined,
            selection.route === "extended-stable" ? "extended-stable" : undefined,
          )
        : null;
    const supported =
      (plugin?.channel === "beta" && plugin.publishTag === "beta") ||
      (plugin?.channel === "stable" &&
        plugin.publishTag === "latest" &&
        selection.npmDistTag === "latest" &&
        parsed &&
        classifyReleaseTrain(parsed) === "stable");
    if (!["normal", "prepared"].includes(selection.route) || !supported) {
      throw new Error(`${row.name}: npm bootstrap is unsupported for this publication route.`);
    }
    action = "owner-preparation-and-access";
  } else if (registry === "clawhub") {
    if (
      selection.route === "prepared" &&
      (!row.state.packageExists ||
        !row.state.hasTrustedPublisher ||
        !isPreparedClawHubTrustedPublisher(row.state.trustedPublisher))
    ) {
      throw new Error("publication ClawHub prepared-trust-required");
    }
    if (row.state.packageExists && row.state.hasTrustedPublisher) {
      return null;
    }
    action = !row.state.packageExists
      ? "bootstrap-and-owner-access"
      : row.state.alreadyPublished
        ? "configure-only"
        : "publisher-repair";
  } else {
    throw new Error("invalid publication authority registry");
  }
  return { registry, name: row.name, action, status: "unresolved" };
}

function validatePublicationObservations(source, value) {
  validatePublicationSourceFact(source);
  if (source.validationPurpose !== "publish") {
    throw new Error("publication observations require a publish source");
  }
  closedObject(
    value,
    [
      "kind",
      "contract",
      "sourceDigest",
      "prerequisitesCompletedAt",
      "collectionStartedAt",
      "collectionCompletedAt",
      "npm",
      "clawhub",
      "pendingAuthority",
      "plans",
    ],
    "publication observations",
  );
  if (
    value.kind !== "openclaw.full-release-publication-observations/v1" ||
    value.contract !== FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT ||
    value.sourceDigest !== source.digest
  ) {
    throw new Error("publication observations source binding mismatch");
  }
  const prerequisites = observationTime(value.prerequisitesCompletedAt);
  const start = observationTime(value.collectionStartedAt);
  const end = observationTime(value.collectionCompletedAt);
  if (prerequisites > start || start > end || end - prerequisites > 300_000) {
    throw new Error("publication observation time ordering is invalid");
  }
  const required = (registry) =>
    source.projection.packages.filter((entry) => entry.targets.includes(registry));
  for (const registry of ["npm", "clawhub"]) {
    observationNames(value[registry], registry);
    const selected = required(registry);
    const actual = registry === "npm" ? value.npm.filter((entry) => entry.required) : value.clawhub;
    if (
      actual.length !== selected.length ||
      actual.some(
        (row) =>
          !selected.some((entry) => row.name === entry.name && row.version === entry.version),
      )
    ) {
      throw new Error("publication required observation roster differs from selected source");
    }
    for (const row of value[registry]) {
      const observed = observationTime(row.observedAt);
      if (observed < start || observed > end) {
        throw new Error("publication observation time is outside collection");
      }
      if (registry === "npm") {
        const observedOutcome = row.outcome === "observed";
        closedObject(
          row,
          [
            "name",
            "version",
            "required",
            "observedAt",
            "outcome",
            observedOutcome ? "state" : "error",
          ],
          "publication npm observation",
        );
        if (
          typeof row.required !== "boolean" ||
          (row.required ? typeof row.version !== "string" : row.version !== null) ||
          (!row.required && selected.some((entry) => entry.name === row.name))
        ) {
          throw new Error("invalid publication npm observation role");
        }
        if (!observedOutcome) {
          if (
            row.required ||
            row.outcome !== "unavailable" ||
            !/^(?:http-[1-5][0-9]{2}|response-too-large|invalid-response|cancelled-or-timeout|read-failed)$/u.test(
              row.error,
            )
          ) {
            throw new Error("required publication npm observation is unavailable");
          }
          continue;
        }
        closedObject(
          row.state,
          ["packageExists", "hasVersionHistory", "selectedVersionExists", "latestVersion"],
          "publication npm state",
        );
        if (
          ["packageExists", "hasVersionHistory", "selectedVersionExists"].some(
            (key) => typeof row.state[key] !== "boolean",
          ) ||
          (!row.state.packageExists &&
            (row.state.hasVersionHistory ||
              row.state.selectedVersionExists ||
              row.state.latestVersion !== null)) ||
          (row.required && row.state.packageExists && !row.state.hasVersionHistory) ||
          (row.state.latestVersion !== null &&
            !text(row.state.latestVersion, "publication latest version", 128))
        ) {
          throw new Error("invalid publication npm history");
        }
      } else {
        closedObject(
          row,
          ["name", "version", "observedAt", "state"],
          "publication ClawHub observation",
        );
        closedObject(
          row.state,
          ["packageExists", "alreadyPublished", "hasTrustedPublisher", "trustedPublisher"],
          "publication ClawHub state",
        );
        if (
          ["packageExists", "alreadyPublished", "hasTrustedPublisher"].some(
            (key) => typeof row.state[key] !== "boolean",
          ) ||
          (!row.state.packageExists &&
            (row.state.alreadyPublished ||
              row.state.hasTrustedPublisher ||
              row.state.trustedPublisher !== null))
        ) {
          throw new Error("invalid publication ClawHub state");
        }
        if (row.state.trustedPublisher !== null) {
          closedObject(
            row.state.trustedPublisher,
            ["provider", "repository", "workflowFilename", "environment"],
            "publication trusted publisher",
          );
          for (const field of Object.values(row.state.trustedPublisher)) {
            if (field !== null) {
              text(field, "publication trusted publisher field", 256);
            }
          }
        }
      }
    }
  }
  if (!Array.isArray(value.pendingAuthority) || value.pendingAuthority.length > 1024) {
    throw new Error("invalid publication pending authority");
  }
  const pendingKeys = new Set();
  for (const pending of value.pendingAuthority) {
    closedObject(
      pending,
      ["registry", "name", "action", "status"],
      "publication pending authority",
    );
    const key = `${pending.registry}/${pending.name}`;
    if (
      pendingKeys.has(key) ||
      pending.status !== "unresolved" ||
      !["npm", "clawhub"].includes(pending.registry) ||
      !required(pending.registry).some((entry) => entry.name === pending.name) ||
      !(
        pending.registry === "npm"
          ? ["owner-preparation-and-access"]
          : ["bootstrap-and-owner-access", "configure-only", "publisher-repair"]
      ).includes(pending.action)
    ) {
      throw new Error("invalid publication pending authority classification");
    }
    pendingKeys.add(key);
  }
  const requiredPending = [
    ...value.npm
      .filter((entry) => entry.required)
      .map((row) => publicationPendingAuthority(source, "npm", row)),
    ...value.clawhub.map((row) => publicationPendingAuthority(source, "clawhub", row)),
  ]
    .filter(Boolean)
    .toSorted((a, b) => compareAscii(`${a.registry}/${a.name}`, `${b.registry}/${b.name}`));
  if (
    publicationObservationJson(value.pendingAuthority) !==
    publicationObservationJson(requiredPending)
  ) {
    throw new Error("publication pending authority differs from required observation states");
  }
  closedObject(value.plans, ["npm", "clawhub"], "publication plans");
  for (const registry of ["npm", "clawhub"]) {
    validateObservationPlan(value.plans[registry], registry, required(registry), value[registry]);
  }
  return value;
}

export function createPublicationObservations(source, observations) {
  return validatePublicationObservations(source, {
    kind: "openclaw.full-release-publication-observations/v1",
    contract: FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT,
    ...observations,
  });
}

export function createPublicationAdmission(source, observations, artifact, admittedAt) {
  const admission = {
    observations,
    binding: {
      kind: "openclaw.full-release-publication-admission/v1",
      contract: FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT,
      repository: source.repository,
      parentRunId: source.runId,
      parentRunAttempt: source.runAttempt,
      workflow: {
        path: ".github/workflows/full-release-validation.yml",
        event: "workflow_dispatch",
        ...source.workflow,
      },
      sourceDigest: source.digest,
      observationsDigest: observationDigest(observations),
      artifact,
      admittedAt,
      status: "admitted-for-validation",
    },
  };
  return validatePublicationAdmissionBinding({
    sourceAdmissionContract: FULL_RELEASE_SOURCE_ADMISSION_CONTRACT,
    sourceAdmission: source,
    publicationAdmissionContract: FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT,
    publicationAdmission: admission,
  });
}

export function validatePublicationAdmissionBinding(record, expected = {}) {
  const contract = record.publicationAdmissionContract;
  if (
    expected.publicationAdmissionContract !== undefined &&
    contract !== expected.publicationAdmissionContract
  ) {
    throw new Error("publication admission contract missing or mismatched");
  }
  if (contract === undefined) {
    if (record.publicationAdmission !== undefined) {
      throw new Error("publication admission omitted its workflow contract");
    }
    return undefined;
  }
  if (contract !== FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT) {
    throw new Error("unsupported publication admission contract");
  }
  const source = validatePublicationSourceBinding(record, {
    ...expected,
    sourceAdmissionContract: FULL_RELEASE_SOURCE_ADMISSION_CONTRACT,
  });
  if (source.validationPurpose !== "publish") {
    if (record.publicationAdmission !== null) {
      throw new Error("nonpublish purpose cannot retain publication admission");
    }
    return null;
  }
  const admission = closedObject(
    record.publicationAdmission,
    ["observations", "binding"],
    "publication admission",
  );
  const observations = validatePublicationObservations(source, admission.observations);
  const binding = closedObject(
    admission.binding,
    [
      "kind",
      "contract",
      "repository",
      "parentRunId",
      "parentRunAttempt",
      "workflow",
      "sourceDigest",
      "observationsDigest",
      "artifact",
      "admittedAt",
      "status",
    ],
    "publication admission binding",
  );
  closedObject(binding.workflow, ["path", "event", "ref", "sha"], "publication workflow");
  if (
    binding.kind !== "openclaw.full-release-publication-admission/v1" ||
    binding.contract !== contract ||
    binding.status !== "admitted-for-validation" ||
    binding.repository !== source.repository ||
    binding.parentRunId !== source.runId ||
    binding.parentRunAttempt !== source.runAttempt ||
    binding.workflow.path !== ".github/workflows/full-release-validation.yml" ||
    binding.workflow.event !== "workflow_dispatch" ||
    binding.workflow.ref !== source.workflow.ref ||
    binding.workflow.sha !== source.workflow.sha ||
    binding.sourceDigest !== source.digest ||
    binding.observationsDigest !== observationDigest(observations)
  ) {
    throw new Error("publication admission identity or observation digest mismatch");
  }
  const artifact = closedObject(
    binding.artifact,
    ["id", "name", "digest", "sizeInBytes"],
    "publication observation artifact",
  );
  if (
    typeof artifact.id !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(artifact.id) ||
    artifact.name !==
      `full-release-publication-observations-${source.runId}-${source.runAttempt}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.sizeInBytes) ||
    artifact.sizeInBytes < 1 ||
    artifact.sizeInBytes > 1024 * 1024 + 8 * 1024
  ) {
    throw new Error("invalid publication observation artifact descriptor");
  }
  const admitted = observationTime(binding.admittedAt);
  if (
    admitted < observationTime(observations.collectionCompletedAt) ||
    admitted - observationTime(observations.prerequisitesCompletedAt) > 300_000 ||
    [...observations.npm.filter((row) => row.required), ...observations.clawhub].some(
      (row) => admitted - observationTime(row.observedAt) > 300_000,
    )
  ) {
    throw new Error("publication admission freshness window exceeded");
  }
  return admission;
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}
if (invokedAsMain) {
  try {
    if (process.argv[2] === "--dispatch") {
      const envelope = dispatchEnvelopeFromInputs(JSON.parse(process.env.PUBLICATION_INPUTS_JSON));
      const identity =
        envelope.trustedWorkflow === null ? "" : publicationSourceJson(envelope.trustedWorkflow);
      appendFileSync(process.env.GITHUB_OUTPUT, `trusted_workflow_json=${identity}\n`);
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `extension_test_exclude_patterns_json=${envelope.laneInputs?.extension_test_exclude_patterns_json ?? "[]"}\n`,
      );
    } else if (process.argv[2] === "--request") {
      const request = publicationSourceRequest(process.env);
      const normalized = publicationIntentInputs(request);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `required=${request.validationPurpose === "publish"}\nvalidation_purpose=${normalized.validationPurpose}\npublication_selection_json=${normalized.publicationSelectionJson}\n`,
        );
      }
      process.stdout.write(publicationSourceJson(request) + "\n");
    } else if (process.argv[2] === "--not-applicable") {
      const retained = JSON.parse(readFileSync(process.argv[3], "utf8"));
      if (retained.validationPurpose === "publish") {
        throw new Error("publish requires source inventory");
      }
      process.stdout.write(
        publicationSourceJson(createPublicationSourceFact(retained, null, null)) + "\n",
      );
    } else {
      throw new Error("unsupported source admission operation");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
