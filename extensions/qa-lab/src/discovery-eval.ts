import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const REQUIRED_DISCOVERY_REFS = [
  "repo/qa/seed-scenarios.json",
  "repo/qa/QA_KICKOFF_TASK.md",
  "repo/extensions/qa-lab/src/suite.ts",
  "repo/docs/help/testing.md",
] as const;

const REQUIRED_DISCOVERY_REFS_LOWER = REQUIRED_DISCOVERY_REFS.map(normalizeLowercaseStringOrEmpty);

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
  const mentionsAllRefs = REQUIRED_DISCOVERY_REFS_LOWER.every((ref) => lower.includes(ref));
  const confirmsRead =
    /(?:read|retrieved|inspected|loaded|accessed|digested)\s+all\s+(?:four|4)\s+(?:(?:requested|required|mandated|seeded)\s+)?files/.test(
      lower,
    ) ||
    /all\s+(?:four|4)\s+(?:(?:requested|required|mandated|seeded)\s+)?files\s+(?:were\s+)?(?:read|retrieved|inspected|loaded|accessed|digested)(?:\s+\w+)?/.test(
      lower,
    ) ||
    /all (?:four|4) seeded files readable/.test(lower);
  return mentionsAllRefs && confirmsRead;
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
