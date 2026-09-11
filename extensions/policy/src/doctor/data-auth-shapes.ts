import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyDataHandlingEvidence, PolicyEvidence } from "../policy-state.js";
import {
  collectPolicyShapeFindings,
  createOrderedPolicyShape,
  firstPolicyShapeFinding,
} from "./ordered-shape.js";
import { SUPPORTED_AUTH_PROFILE_MODES } from "./policy-constants.js";

export function dataHandlingPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.dataHandling)) {
    return [];
  }
  const shape = createOrderedPolicyShape(policy, { policyPath, policyDocName });
  const sections = [
    ["sensitiveLogging", "requireRedaction"],
    ["telemetry", "denyContentCapture"],
    ["retention", "requireSessionMaintenance"],
    ["memory", "denySessionTranscriptIndexing"],
  ] as const;
  function* sectionRules(section: string, rule: string) {
    yield shape.keys(
      "dataHandling." + section,
      [rule],
      "data-handling",
      "Remove {unsupported} or use {property}." + rule + ".",
    );
    yield shape.boolean("dataHandling." + section + "." + rule);
  }
  function* findings() {
    yield shape.keys(
      "dataHandling",
      ["memory", "retention", "sensitiveLogging", "telemetry"],
      "data-handling",
      "Remove {unsupported} or use a supported data-handling policy rule.",
    );
    for (const [section] of sections) {
      yield shape.object(
        "dataHandling." + section,
        "Fix {property} so it contains boolean policy rules.",
      );
    }
    for (const [section, rule] of sections) {
      yield firstPolicyShapeFinding(sectionRules(section, rule));
    }
  }
  return collectPolicyShapeFindings(findings());
}

export function dataHandlingEntries(
  evidence: PolicyEvidence,
  kind: PolicyDataHandlingEvidence["kind"],
): readonly PolicyDataHandlingEvidence[] {
  return (evidence.dataHandling ?? []).filter((entry) => entry.kind === kind);
}

export function dataHandlingLabel(entry: PolicyDataHandlingEvidence): string {
  return entry.agentId === undefined
    ? "Global data handling config"
    : "agent '" + entry.agentId + "'";
}

export function secretPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.secrets)) {
    return [];
  }
  const shape = createOrderedPolicyShape(policy, { policyPath, policyDocName });
  function* findings() {
    yield shape.boolean("secrets.requireManagedProviders");
    yield shape.boolean("secrets.allowInsecureProviders");
    yield shape.list("secrets.denySources", {
      array: {
        message: "{policy} {property} must be an array of source names.",
        hint: 'Use an array such as ["exec"] or remove secrets.denySources.',
      },
      entry: {
        message: "{policy} {property}[{index}] must be a non-empty source name.",
        hint: "Use non-empty source names such as env, file, exec, or openclaw.",
      },
    });
  }
  return collectPolicyShapeFindings(findings());
}

export function authProfileAllowModesShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  const shape = createOrderedPolicyShape(policy, { policyPath, policyDocName });
  const finding = shape.list("auth.profiles.allowModes", {
    allowed: SUPPORTED_AUTH_PROFILE_MODES,
    normalize: "lower",
    array: {
      message: "{policy} {property} must be an array of auth modes.",
      hint: "Use supported auth modes: {allowed}.",
    },
    entry: {
      message: "{policy} {property}[{index}] must be a supported auth mode.",
      hint: "Use supported auth modes: {allowed}.",
    },
  });
  return finding === undefined ? [] : [finding];
}
