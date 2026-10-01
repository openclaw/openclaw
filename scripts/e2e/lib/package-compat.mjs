// Candidate-package compatibility helpers for E2E acceptance scripts.
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { isDirectRunUrl } from "../../lib/direct-run.mjs";

// Candidates on either side of consent enforcement can share a package version.
// Only successful command help establishes support; callers own probe failures.
export function fixtureCapabilityConsentArgs(help) {
  return /^[\t ]*--accept-capabilities(?:[\t ]|$)/m.test(stripVTControlCharacters(help))
    ? ["--accept-capabilities"]
    : [];
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  // Frozen runners call the release-security probe from their retained upgrade
  // harness. Only v2026.6.35 predates that ClawHub endpoint.
  console.log(
    process.argv[2] === "fixture-consent"
      ? fixtureCapabilityConsentArgs(readFileSync(0, "utf8")).join("\n")
      : process.argv[2] === "--clawhub-release-security-mode"
        ? process.argv[3] === "2026.6.35"
          ? "absent"
          : "required"
        : "0",
  );
}
