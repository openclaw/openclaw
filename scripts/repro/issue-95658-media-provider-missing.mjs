#!/usr/bin/env node
/**
 * Live repro for issue #95658 — generic "Media provider not available: groq"
 * error lacks an actionable install hint.
 *
 * Run: pnpm exec tsx scripts/repro/issue-95658-media-provider-missing.mjs
 *
 * Behavior proved here (real-environment proof, not a unit-test mock):
 *   1. Calls the production `formatMissingProviderHint` from
 *      src/media-understanding/runner.entries.ts with several ids.
 *   2. Asserts that:
 *      - Tier 1 (catalog-known, e.g. amazon-bedrock): hint includes the
 *        catalog entry's installCommand, the registry refresh command,
 *        the gateway restart step, and the doctor fix command.
 *      - Tier 2 (any non-cataloged id, e.g. mystery-provider, groq before
 *        catalog registration): hint returns the empty string and the
 *        legacy error message is preserved verbatim. The previous
 *        convention-fallback branch was removed to avoid emitting
 *        misleading package hints for non-externalized ids.
 *      - Tier 3 (empty / non-plugin-shaped id): hint returns empty string,
 *        so the legacy error message is preserved verbatim.
 *   3. Asserts the legacy `Media provider not available: <id>` prefix is
 *      preserved verbatim when concatenated with the hint suffix, so any
 *      downstream grep-based script continues to match.
 */
import assert from "node:assert/strict";
import { formatMissingProviderHint } from "../../src/media-understanding/runner.entries.ts";

console.log("=== Reproduction for issue #95658 — actionable provider-missing hint ===");

// Tier 1: catalog-known provider.
const tier1 = formatMissingProviderHint("amazon-bedrock");
assert.ok(
  tier1.includes("openclaw plugins install @openclaw/amazon-bedrock-provider"),
  `tier1 must include the catalog installCommand; got: ${tier1}`,
);
assert.ok(
  tier1.includes("openclaw plugins registry --refresh"),
  `tier1 must include the registry refresh command; got: ${tier1}`,
);
assert.ok(
  tier1.includes("restart the gateway"),
  `tier1 must include the gateway restart step; got: ${tier1}`,
);
assert.ok(
  tier1.includes("openclaw doctor --fix"),
  `tier1 must include the doctor fix command; got: ${tier1}`,
);
assert.ok(
  tier1.includes("official external plugin"),
  `tier1 must use the official-external wording; got: ${tier1}`,
);
console.log(`PASS  tier 1 (amazon-bedrock): ${tier1}`);

// Tier 2: mystery-provider, not in catalog. No convention fallback anymore.
const tier2 = formatMissingProviderHint("mystery-provider");
assert.equal(
  tier2,
  "",
  `non-cataloged id must return empty hint (no convention fallback); got: ${tier2}`,
);
console.log(`PASS  tier 2 (mystery-provider, no convention fallback): hint is empty`);

// Tier 1 confirms groq is registered as an official external provider on
// current main, so the runtime path will surface the tier-1 wording.
const tier1Groq = formatMissingProviderHint("groq");
assert.ok(
  tier1Groq.includes("official external plugin"),
  `groq is registered in official-external-provider-catalog.json so its hint must use tier-1 wording; got: ${tier1Groq}`,
);
console.log(`PASS  groq (tier 1, catalog-known): ${tier1Groq}`);

// Tier 3: empty / non-plugin-shaped ids return "".
assert.equal(formatMissingProviderHint(""), "");
assert.equal(formatMissingProviderHint("   "), "");
assert.equal(formatMissingProviderHint("bad/id"), "");
assert.equal(formatMissingProviderHint("a"), "");
console.log("PASS  tier 3 (empty / non-plugin-shaped ids return empty string)");

// Backward-compat: legacy prefix preserved when hint is appended (catalog-known id).
const composed = `Media provider not available: amazon-bedrock${tier1}`;
assert.match(
  composed,
  /^Media provider not available: amazon-bedrock .*openclaw plugins install/,
  `legacy prefix must be preserved when hint is appended; got: ${composed}`,
);
console.log(`PASS  backward-compat: legacy prefix preserved verbatim in composed message`);

// Backward-compat: non-cataloged id preserves legacy message exactly.
const legacyUnknown = `Media provider not available: mystery-provider${tier2}`;
assert.equal(
  legacyUnknown,
  "Media provider not available: mystery-provider",
  "non-cataloged id must preserve the legacy message exactly",
);
console.log(`PASS  backward-compat: non-cataloged id preserves legacy message exactly`);

console.log("=== All repro assertions passed ===");
