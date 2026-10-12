import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compareAscii } from "./canonical-json.mjs";
import { isRecord } from "./record-shared.mjs";
import { validateQualificationBaselines } from "./release-upgrade-baseline.mjs";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version.mjs";

export const QUALIFICATION_BASELINE_POLICY_PATH = "scripts/lib/upgrade-survivor-scenarios.json";
const digest = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export function validateQualificationBaselinePolicy(request, policy) {
  if (
    !isRecord(policy) ||
    !isDeepStrictEqual(
      Object.keys(policy).toSorted(compareAscii),
      [
        "candidateVersion",
        "oldestSupportedBaseline",
        "packageSourceDigest",
        "policySourceDigest",
      ].toSorted(compareAscii),
    ) ||
    typeof policy.candidateVersion !== "string" ||
    !parseReleaseVersion(policy.candidateVersion) ||
    (policy.oldestSupportedBaseline !== null &&
      (typeof policy.oldestSupportedBaseline !== "string" ||
        parseReleaseVersion(policy.oldestSupportedBaseline)?.channel !== "stable" ||
        parseReleaseVersion(policy.oldestSupportedBaseline)?.version !==
          policy.oldestSupportedBaseline)) ||
    !digestPattern.test(policy.packageSourceDigest) ||
    !digestPattern.test(policy.policySourceDigest)
  ) {
    throw new Error("Invalid candidate-owned qualification baseline policy");
  }
  const envelope = JSON.parse(request.inputs.trusted_workflow_json);
  const raw = envelope.laneInputs?.qualification_baselines_json;
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 16 * 1024) {
    throw new Error("Qualification admission requires the nonempty frozen baseline tuple");
  }
  const supplied = JSON.parse(raw);
  const context = {
    candidateVersion: policy.candidateVersion,
    targetContextRef: request.inputs.target_context_ref,
  };
  const baselines = validateQualificationBaselines(supplied, context);
  if (!isDeepStrictEqual(supplied, baselines)) {
    throw new Error("Qualification admission requires canonical frozen baselines");
  }
  const extended = String(context.targetContextRef ?? "")
    .replace(/^refs\/heads\//u, "")
    .startsWith("extended-stable/");
  if (
    !extended &&
    policy.oldestSupportedBaseline !== null &&
    compareReleaseVersions(policy.oldestSupportedBaseline, policy.candidateVersion) < 0 &&
    !baselines.upgradeSurvivorBaselines.includes("openclaw@" + policy.oldestSupportedBaseline)
  ) {
    throw new Error("Frozen baselines omit the candidate-owned oldest-supported baseline");
  }
  if (
    baselines.upgradeSurvivorBaselines.some(
      (spec) => compareReleaseVersions(spec.slice(9), baselines.upgradeBaseline.slice(9)) > 0,
    )
  ) {
    throw new Error("Frozen upgrade baseline must be the newest selected predecessor");
  }
  return baselines;
}

// P reads these immutable Q blobs, not Q code or today's registry. The selected
// tuple already lives in the authenticated request; retain only its source facts.
export function qualificationBaselinePolicy(request, packageBytes, policyBytes) {
  const candidate = JSON.parse(packageBytes.toString("utf8"));
  const source = JSON.parse(policyBytes.toString("utf8"));
  const policy = {
    candidateVersion: candidate.version,
    oldestSupportedBaseline: source.oldestSupportedBaseline,
    packageSourceDigest: digest(packageBytes),
    policySourceDigest: digest(policyBytes),
  };
  validateQualificationBaselinePolicy(request, policy);
  return policy;
}
