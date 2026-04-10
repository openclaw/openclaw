import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { readQaScenarioExecutionConfig } from "./scenario-catalog.js";

const DEFAULT_REQUIRED_DISCOVERY_REFS = [
  "repo/qa/scenarios/index.md",
  "repo/extensions/qa-lab/src/suite.ts",
  "repo/docs/help/testing.md",
] as const;

let cachedRequiredDiscoveryRefs: readonly string[] | null = null;
let cachedRequiredDiscoveryRefsLower: readonly string[] | null = null;

function readRequiredDiscoveryRefs() {
  const config = readQaScenarioExecutionConfig("source-docs-discovery-report") as
    | { requiredFiles?: unknown }
    | undefined;
  const requiredFiles = Array.isArray(config?.requiredFiles)
    ? config.requiredFiles.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  return requiredFiles.length > 0 ? requiredFiles : DEFAULT_REQUIRED_DISCOVERY_REFS;
}

function getRequiredDiscoveryRefs() {
  if (cachedRequiredDiscoveryRefs) {
    return cachedRequiredDiscoveryRefs;
  }
  try {
    cachedRequiredDiscoveryRefs = readRequiredDiscoveryRefs();
  } catch {
    // Global npm installs do not ship the qa/scenarios source pack.
    cachedRequiredDiscoveryRefs = DEFAULT_REQUIRED_DISCOVERY_REFS;
  }
  return cachedRequiredDiscoveryRefs;
}

function getRequiredDiscoveryRefsLower() {
  if (cachedRequiredDiscoveryRefsLower) {
    return cachedRequiredDiscoveryRefsLower;
  }
  cachedRequiredDiscoveryRefsLower = getRequiredDiscoveryRefs().map(
    normalizeLowercaseStringOrEmpty,
  );
  return cachedRequiredDiscoveryRefsLower;
}

const DISCOVERY_SCOPE_LEAK_PHRASES = [
  "all mandatory scenarios",
  "final qa tally",
  "final qa tally update",
  "qa run complete",
  "scenario: `subagent-handoff`",
  "scenario: subagent-handoff",
] as const;

function confirmsDiscoveryFileRead(text: string) {
  const lower = normalizeLowercaseStringOrEmpty(text);
  const mentionsAllRefs = getRequiredDiscoveryRefsLower().every((ref) => lower.includes(ref));
  const mentionsReadVerb = /(?:read|retrieved|inspected|loaded|accessed|digested)/.test(lower);
  const requiredCountPattern = "(?:three|3|four|4)";
  const confirmsRead =
    new RegExp(
      `(?:read|retrieved|inspected|loaded|accessed|digested)\\s+all\\s+${requiredCountPattern}\\s+(?:(?:requested|required|mandated|seeded)\\s+)?files`,
    ).test(lower) ||
    new RegExp(
      `all\\s+${requiredCountPattern}\\s+(?:(?:requested|required|mandated|seeded)\\s+)?files\\s+(?:were\\s+)?(?:read|retrieved|inspected|loaded|accessed|digested)(?:\\s+\\w+)?`,
    ).test(lower) ||
    new RegExp(`all\\s+${requiredCountPattern}\\s+seeded files readable`).test(lower);
  return mentionsAllRefs && (confirmsRead || mentionsReadVerb);
}

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
  if (confirmsDiscoveryFileRead(text)) {
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
