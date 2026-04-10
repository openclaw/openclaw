import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { readQaScenarioExecutionConfig } from "./scenario-catalog.js";

const DEFAULT_REQUIRED_DISCOVERY_REFS = [
  "repo/qa/scenarios/index.md",
  "repo/extensions/qa-lab/src/suite.ts",
  "repo/docs/help/testing.md",
] as const;
const MAX_REQUIRED_DISCOVERY_REFS_TOTAL_LENGTH = 1024;
const MAX_REQUIRED_DISCOVERY_REF_LENGTH = 256;

let cachedRequiredDiscoveryRefsLower: string[] | undefined;

function shouldFallbackRequiredDiscoveryRefs(error: unknown) {
  return (
    error instanceof Error &&
    error.message.startsWith("qa scenario pack not found:")
  );
}

function sanitizeRequiredDiscoveryRefs(requiredFiles: unknown): string[] {
  if (!Array.isArray(requiredFiles)) {
    return [];
  }
  const sanitized: string[] = [];
  let totalLength = 0;
  for (const value of requiredFiles) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_REQUIRED_DISCOVERY_REF_LENGTH) {
      continue;
    }
    if (totalLength + trimmed.length > MAX_REQUIRED_DISCOVERY_REFS_TOTAL_LENGTH) {
      break;
    }
    sanitized.push(trimmed);
    totalLength += trimmed.length;
  }
  return sanitized;
}

function readRequiredDiscoveryRefs() {
  try {
    const config = readQaScenarioExecutionConfig("source-docs-discovery-report") as
      | { requiredFiles?: unknown }
      | undefined;
    const configuredRefs = sanitizeRequiredDiscoveryRefs(config?.requiredFiles);
    return configuredRefs.length > 0 ? configuredRefs : [...DEFAULT_REQUIRED_DISCOVERY_REFS];
  } catch (error) {
    if (!shouldFallbackRequiredDiscoveryRefs(error)) {
      throw error;
    }
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
