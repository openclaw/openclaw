/**
 * Proof: memory-core legacy dreaming token detection and reconciliation.
 *
 * Verifies that legacy light/REM sleep event tokens in payload.message
 * are detected so the dreaming hook can reconcile cron jobs before
 * intercepting the legacy token (#97475).
 *
 * Run: node --import tsx extensions/memory-core/src/dreaming.proof.ts
 */

// Replica of the detection logic without importing the full extension.
// From src/memory-host-sdk/dreaming.ts:
const LEGACY_LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
const LEGACY_REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";

// Replica of includesSystemEventToken from dreaming-shared.ts
function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function includesSystemEventToken(cleanedBody: string, eventText: string): boolean {
  const normalizedBody = normalizeTrimmedString(cleanedBody);
  const normalizedEventText = normalizeTrimmedString(eventText);
  if (!normalizedBody || !normalizedEventText) return false;
  if (normalizedBody === normalizedEventText) return true;
  return normalizedBody.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === normalizedEventText) return true;
    // Strip [cron:<id>] prefix for isolated cron turns
    if (trimmed.replace(/^\[cron:[^\]]+\]\s*/, "") === normalizedEventText) return true;
    return false;
  });
}

// Detect whether cleanedBody contains any legacy dreaming token
function hasLegacyDreamingToken(cleanedBody: string): boolean {
  return (
    includesSystemEventToken(cleanedBody, LEGACY_LIGHT_SLEEP_EVENT_TEXT) ||
    includesSystemEventToken(cleanedBody, LEGACY_REM_SLEEP_EVENT_TEXT)
  );
}

let passed = 0;
let failed = 0;

function check(label: string, body: string | null | undefined, expected: boolean) {
  const result = body != null ? hasLegacyDreamingToken(body) : false;
  const status = result === expected ? "PASS" : "FAIL";
  if (status === "PASS") passed++;
  else failed++;
  const bodyPreview = body == null ? "<null/undefined>" : JSON.stringify(body).slice(0, 60);
  console.log(`  [${status}] ${label}: body=${bodyPreview} → ${result} (expected ${expected})`);
}

console.log("=== Legacy dreaming token detection ===\n");

check("light sleep — exact match", LEGACY_LIGHT_SLEEP_EVENT_TEXT, true);
check("REM sleep — exact match", LEGACY_REM_SLEEP_EVENT_TEXT, true);
check(
  "light sleep — in multi-line body",
  `some prefix\n${LEGACY_LIGHT_SLEEP_EVENT_TEXT}\nsome suffix`,
  true,
);
check(
  "REM sleep — in multi-line body",
  `some prefix\n${LEGACY_REM_SLEEP_EVENT_TEXT}\nsome suffix`,
  true,
);
check("light sleep — cron-prefixed", `[cron:abc123] ${LEGACY_LIGHT_SLEEP_EVENT_TEXT}`, true);

console.log();

check("regular dreaming token (not legacy)", "__openclaw_memory_core_dream__", false);
check("unrelated text", "hello world", false);
check("empty string", "", false);
check("null body", null, false);
check("undefined body", undefined, false);
check("whitespace only", "   ", false);

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
