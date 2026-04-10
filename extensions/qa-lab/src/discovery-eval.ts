import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { readQaScenarioExecutionConfig } from "./scenario-catalog.js";

const DEFAULT_REQUIRED_DISCOVERY_REFS = [
  "repo/qa/scenarios/index.md",
  "repo/extensions/qa-lab/src/suite.ts",
  "repo/docs/help/testing.md",
] as const;
const MAX_REQUIRED_DISCOVERY_REFS = DEFAULT_REQUIRED_DISCOVERY_REFS.length;
const MAX_REQUIRED_DISCOVERY_REF_LENGTH = 256;

let cachedRequiredDiscoveryRefsLower: string[] | undefined;

function sanitizeRequiredDiscoveryRefs(requiredFiles: unknown): string[] {
  if (!Array.isArray(requiredFiles)) {
    return [];
  }
  return requiredFiles
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length > 0 &&
        value.length <= MAX_REQUIRED_DISCOVERY_REF_LENGTH,
    )
    .slice(0, MAX_REQUIRED_DISCOVERY_REFS);
}

function readRequiredDiscoveryRefs() {
  try {
    const config = readQaScenarioExecutionConfig("source-docs-discovery-report") as
      | { requiredFiles?: unknown }
      | undefined;
    const configuredRefs = sanitizeRequiredDiscoveryRefs(config?.requiredFiles);
    return configuredRefs.length > 0 ? configuredRefs : [...DEFAULT_REQUIRED_DISCOVERY_REFS];
  } catch {
    return [...DEFAULT_REQUIRED_DISCOVERY_REFS];
  }
}

function getRequiredDiscoveryRefsLower() {
  cachedRequiredDiscoveryRefsLower ??= readRequiredDiscoveryRefs().map(
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
  const requiredRefsLower = getRequiredDiscoveryRefsLower();
  const mentionsAllRefs = requiredRefsLower.every((ref) => lower.includes(ref));
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
