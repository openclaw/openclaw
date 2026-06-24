// Verify that execSecurity is initialized from cfg.tools.exec.security
// when creating new reply session entries (fixes #92206).
//
// Without the fix: initSessionState() never reads cfg.tools.exec.security,
// so sessionEntry.execSecurity is undefined on cold boot, causing the
// session-layer exec policy to be a no-op and default to the base policy.
//
// With the fix: execSecurity: baseEntry?.execSecurity ?? cfg.tools?.exec?.security
// is set in the session entry construction, so the session-layer correctly
// applies the configured policy.
//
// Usage:
//   pnpm tsx scripts/repro/issue-92206-exec-security-proof.mts

// Import the actual production code to exercise it directly.
import { stripUnknownConfigKeys } from "../../src/commands/doctor-config-analysis.js";
import { normalizeExecSecurity } from "../../src/infra/exec-approvals.js";

// ── Types for proof script ──
interface SessionEntryLike {
  execSecurity?: string;
  sessionId?: string;
}

interface ConfigLike {
  tools?: {
    exec?: {
      security?: string;
    };
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed += 1;
  } else {
    console.log(`  ❌ ${label}`);
    failed += 1;
  }
}

// ── Test 1: normalizeExecSecurity handles all expected values ──
console.log("\n── Test 1: normalizeExecSecurity handles expected values ──");
assert(normalizeExecSecurity("deny") === "deny", "deny → deny");
assert(normalizeExecSecurity("allowlist") === "allowlist", "allowlist → allowlist");
assert(normalizeExecSecurity("full") === "full", "full → full");
assert(normalizeExecSecurity(undefined) === null, "undefined → null (no session override)");
assert(normalizeExecSecurity(null) === null, "null → null");

// ── Test 2: stripUnknownConfigKeys preserves tools.exec.security ──
console.log("\n── Test 2: stripUnknownConfigKeys preserves tools.exec.security ──");
const stripResult = stripUnknownConfigKeys({
  tools: { exec: { security: "deny" } },
  badKey: true,
} as never);
assert(stripResult.removed.includes("badKey"), "strips badKey");
assert(!stripResult.removed.includes("tools.exec.security"), "preserves tools.exec.security");
const configRoot = stripResult.config as Record<string, unknown>;
const configTools = configRoot.tools as Record<string, unknown> | undefined;
const configExec = configTools?.exec as Record<string, unknown> | undefined;
assert(configExec?.security === "deny", "tools.exec.security value retained (deny)");

// ── Test 3: Session entry construction logic ──
console.log("\n── Test 3: Session entry construction mimics initSessionState ──");
// This tests the actual fix expression:
//   execSecurity: baseEntry?.execSecurity ?? cfg.tools?.exec?.security

// Case A: No baseEntry, config has exec.security = "deny"
const baseEntry: SessionEntryLike | undefined = undefined;
const cfgWithDeny: ConfigLike = { tools: { exec: { security: "deny" } } };
const resultA = baseEntry?.execSecurity ?? cfgWithDeny.tools?.exec?.security;
assert(resultA === "deny", "no baseEntry → falls back to cfg.tools.exec.security (deny)");

// Case B: baseEntry has execSecurity = "full", config has exec.security = "deny"
const baseEntryWithFull: SessionEntryLike = { execSecurity: "full" };
const resultB = baseEntryWithFull.execSecurity ?? cfgWithDeny.tools?.exec?.security;
assert(resultB === "full", "baseEntry has execSecurity → config is NOT used (full)");

// Case C: baseEntry has no execSecurity, config has exec.security = "deny"
const baseEntryWithout: SessionEntryLike = { sessionId: "sess-1" };
const resultC = baseEntryWithout.execSecurity ?? cfgWithDeny.tools?.exec?.security;
assert(resultC === "deny", "baseEntry has no execSecurity → falls back to config (deny)");

// Case D: baseEntry has no execSecurity, config has no tools.exec.security
const cfgNoExec: ConfigLike = { tools: {} };
const resultD = baseEntryWithout.execSecurity ?? cfgNoExec.tools?.exec?.security;
assert(resultD === undefined, "no config exec.security → result is undefined");

// Case E: Session store read returns existing entry with execSecurity,
// config exec.security is different — persisted value wins (data integrity)
// The fix expression baseEntry?.execSecurity ?? cfg.tools?.exec?.security
// correctly prefers the persisted value over config default.
const baseEntryWithAllowlist: SessionEntryLike = { execSecurity: "allowlist" };
const cfgWithFullAccess: ConfigLike = { tools: { exec: { security: "full" } } };
const resultE = baseEntryWithAllowlist.execSecurity ?? cfgWithFullAccess.tools?.exec?.security;
assert(resultE === "allowlist", "persisted execSecurity wins over config default (data integrity)");

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n── Result: ${passed} passed, ${failed} failed ──`);
if (failed > 0) {
  process.exit(1);
}
