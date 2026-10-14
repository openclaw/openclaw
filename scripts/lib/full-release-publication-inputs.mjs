// One owner normalizes release intent, frozen lane inputs, and the dispatch envelope.
import { canonicalizeJsonValue, compareAscii } from "./canonical-json.mjs";
import { validateQualificationBaselines } from "./release-upgrade-baseline.mjs";
const purposes = ["publish", "diagnostic", "main-qualification", "postpublish-confidence"];
const maximumBytes = 128 * 1024;
const sha = /^[a-f0-9]{40}$/u;
const packageName = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;

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
  if (selected.route === "alpha" || selected.npmDistTag === "alpha") {
    throw new Error("Alpha releases are retired; use a beta prerelease instead.");
  }
  if (
    !["normal", "prepared", "extended-stable"].includes(selected.route) ||
    !["beta", "latest", "extended-stable"].includes(selected.npmDistTag) ||
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
  if ((selected.route === "extended-stable") !== (selected.npmDistTag === "extended-stable")) {
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
  object(
    value,
    ["extension_test_exclude_patterns_json", "qualification_baselines_json"],
    "source-admission lane inputs",
  );
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      if (typeof raw !== "string" || raw.length > 4096) {
        throw new Error(`invalid ${key}`);
      }
      const entries = JSON.parse(raw);
      if (key === "qualification_baselines_json") {
        return [key, JSON.stringify(validateQualificationBaselines(entries))];
      }
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
    [
      "trustedWorkflow",
      "validationPurpose",
      "publicationSelection",
      "laneInputs",
      "qualificationAdmission",
    ],
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
  if (
    value.qualificationAdmission !== undefined &&
    (!value.qualificationAdmission ||
      typeof value.qualificationAdmission !== "object" ||
      Array.isArray(value.qualificationAdmission))
  ) {
    throw new Error("qualification admission locator must be an object");
  }
  return {
    trustedWorkflow,
    ...(value.qualificationAdmission === undefined
      ? {}
      : { qualificationAdmission: value.qualificationAdmission }),
    ...(laneInputs === undefined ? {} : { laneInputs }),
    ...normalizePublicationIntent(
      value.validationPurpose,
      value.publicationSelection === null ? "" : publicationSourceJson(value.publicationSelection),
    ),
  };
}

export function publicationDispatchEnvelope(
  trustedWorkflow,
  intent,
  laneInputs,
  qualificationAdmission,
) {
  return publicationSourceJson(
    decodePublicationDispatchEnvelope(
      publicationSourceJson({
        trustedWorkflow,
        ...intent,
        ...(laneInputs ? { laneInputs } : {}),
        ...(qualificationAdmission === undefined ? {} : { qualificationAdmission }),
      }),
    ),
  );
}

export function dispatchEnvelopeFromInputs(inputs) {
  if (
    Object.hasOwn(inputs, "validation_purpose") ||
    Object.hasOwn(inputs, "publication_selection_json") ||
    Object.hasOwn(inputs, "extension_test_exclude_patterns_json") ||
    Object.hasOwn(inputs, "qualification_baselines_json")
  ) {
    throw new Error("source intent must use only the trusted_workflow_json envelope");
  }
  return decodePublicationDispatchEnvelope(inputs.trusted_workflow_json);
}

export {
  object as publicationInputRecord,
  text as publicationInputText,
  packageName as publicationPackageNamePattern,
};
