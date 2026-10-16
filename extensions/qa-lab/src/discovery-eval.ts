import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readQaScenarioExecutionConfig } from "./scenario-catalog.js";

const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report") as
  | { requiredFiles?: string[] }
  | undefined;
const REQUIRED_DISCOVERY_REFS_LOWER = (
  discoveryConfig?.requiredFiles ?? [
    "repo/qa/scenarios/index.yaml",
    "repo/extensions/qa-lab/src/suite.ts",
    "repo/docs/help/testing.md",
  ]
).map(normalizeLowercaseStringOrEmpty);

const DISCOVERY_SCOPE_LEAK_PHRASES = [
  "all mandatory scenarios",
  "final qa tally",
  "final qa tally update",
  "qa run complete",
  "scenario: `subagent-handoff`",
  "scenario: subagent-handoff",
] as const;

export function hasDiscoveryLabels(text: string) {
  const lower = normalizeLowercaseStringOrEmpty(text);
  return (
    lower.includes("worked") &&
    lower.includes("failed") &&
    lower.includes("blocked") &&
    (lower.includes("follow-up") || lower.includes("follow up"))
  );
}

export function reportsMissingDiscoveryFiles(text: string) {
  const lower = normalizeLowercaseStringOrEmpty(text);
  if (
    REQUIRED_DISCOVERY_REFS_LOWER.every((ref) => lower.includes(ref)) &&
    /(?:read|retrieved|inspected|loaded|accessed|digested)/.test(lower)
  ) {
    return false;
  }
  return (
    lower.includes("not present") ||
    lower.includes("missing files") ||
    lower.includes("blocked by missing") ||
    lower.includes("could not inspect")
  );
}

export function reportsDiscoveryScopeLeak(text: string) {
  const lower = normalizeLowercaseStringOrEmpty(text);
  return DISCOVERY_SCOPE_LEAK_PHRASES.some((phrase) => lower.includes(phrase));
}
