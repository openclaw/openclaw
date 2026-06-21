/**
 * Real behavior proof: session title contract end-to-end
 *
 * Exercises the patched sessions-patch.ts, session-label.ts, and
 * session-utils.ts with real session entries — no mocks, no Telegram.
 *
 * Run: node --import tsx scripts/proof-session-title.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const EMPTY_CFG = {} as any;

// ---------------------------------------------------------------------------
// Import the actual patched modules
// ---------------------------------------------------------------------------

const { applySessionsPatchToStore } = await import(join(ROOT, "src/gateway/sessions-patch.js"));

const {
  applySessionTitle,
  getSessionTitleFromEntry,
  parseSessionTitle,
  parseSessionLabel,
  sessionTitlesEqual,
} = await import(join(ROOT, "src/sessions/session-label.js"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(msg: string) {
  passed++;
  console.log(`  PASS  ${msg}`);
}
function fail(msg: string) {
  failed++;
  console.error(`  FAIL  ${msg}`);
}

function assertEq(actual: any, expected: any, msg: string) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.error(
      `  FAIL  ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

function makeStore(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    "agent:main:main": {
      sessionId: "proof-sess-001",
      updatedAt: 1,
      ...overrides,
    },
  };
}

async function patch(store: Record<string, any>, patchData: Record<string, any>) {
  return applySessionsPatchToStore({
    cfg: EMPTY_CFG,
    store,
    storeKey: "agent:main:main",
    patch: { key: "agent:main:main", ...patchData },
  });
}

// ---------------------------------------------------------------------------
// Proof 1: parseSessionTitle / parseSessionLabel
// ---------------------------------------------------------------------------

console.log("\n=== Proof 1: parseSessionTitle / parseSessionLabel ===\n");

{
  const r1 = parseSessionTitle("My Session");
  assert(r1.ok === true, 'parseSessionTitle("My Session") succeeds');
  assertEq((r1 as any).title, "My Session", "title value preserved");

  const r2 = parseSessionTitle("  Trim Me  ");
  assertEq((r2 as any).title, "Trim Me", "title is trimmed");

  const r3 = parseSessionTitle("");
  assert(r3.ok === false, 'parseSessionTitle("") fails');

  const r4 = parseSessionTitle(null as any);
  assert(r4.ok === false, "parseSessionTitle(null) fails");

  const r5 = parseSessionTitle(123 as any);
  assert(r5.ok === false, "parseSessionTitle(123) fails");

  const r6 = parseSessionLabel("Legacy Label");
  assert(r6.ok === true, 'parseSessionLabel("Legacy Label") succeeds');
  assertEq((r6 as any).label, "Legacy Label", "label value preserved");

  const r7 = parseSessionLabel("");
  assert(r7.ok === false, 'parseSessionLabel("") fails');
}

// ---------------------------------------------------------------------------
// Proof 2: applySessionTitle — set and clear
// ---------------------------------------------------------------------------

console.log("\n=== Proof 2: applySessionTitle — set and clear ===\n");

{
  const entry: any = {};

  applySessionTitle(entry, "Hello World");
  assertEq(entry.title, "Hello World", "set: title stored");
  assertEq(entry.label, "Hello World", "set: label mirror populated");

  applySessionTitle(entry, null);
  assertEq(entry.title, undefined, "clear: title removed");
  assertEq(entry.label, undefined, "clear: label mirror removed");
}

// ---------------------------------------------------------------------------
// Proof 3: getSessionTitleFromEntry — title takes priority over label
// ---------------------------------------------------------------------------

console.log("\n=== Proof 3: getSessionTitleFromEntry — priority ===\n");

{
  assertEq(getSessionTitleFromEntry({ title: "A", label: "B" }), "A", "title wins over label");
  assertEq(getSessionTitleFromEntry({ label: "B" }), "B", "label used when no title");
  assertEq(getSessionTitleFromEntry({}), undefined, "empty entry → undefined");
  assertEq(getSessionTitleFromEntry(null), undefined, "null entry → undefined");
}

// ---------------------------------------------------------------------------
// Proof 4: sessionTitlesEqual
// ---------------------------------------------------------------------------

console.log("\n=== Proof 4: sessionTitlesEqual ===\n");

{
  assert(sessionTitlesEqual("café", "café"), "NFC-equal strings match");
  assert(!sessionTitlesEqual("foo", "bar"), "different strings don't match");
  assert(!sessionTitlesEqual(null as any, "foo"), "null left → false");
  assert(!sessionTitlesEqual("foo", undefined as any), "undefined right → false");
}

// ---------------------------------------------------------------------------
// Proof 5: sessions.create — set title on new session
// ---------------------------------------------------------------------------

console.log("\n=== Proof 5: sessions.create — set title on new session ===\n");

{
  const store = makeStore();
  const result = await patch(store, { title: "My Proof Session" });
  assert(result.ok === true, "create with title succeeds");
  assertEq((result as any).entry.title, "My Proof Session", "title persisted");
  assertEq((result as any).entry.label, "My Proof Session", "label mirror set");
}

// ---------------------------------------------------------------------------
// Proof 6: /name <title> — rename session
// ---------------------------------------------------------------------------

console.log("\n=== Proof 6: /name <title> — rename session ===\n");

{
  const store = makeStore({ title: "Old Name", label: "Old Name" });
  const result = await patch(store, { title: "New Name" });
  assert(result.ok === true, "rename succeeds");
  assertEq((result as any).entry.title, "New Name", "title updated");
  assertEq((result as any).entry.label, "New Name", "label mirror updated");
}

// ---------------------------------------------------------------------------
// Proof 7: /name --clear — clear via title: null
// ---------------------------------------------------------------------------

console.log("\n=== Proof 7: /name --clear — clear via title: null ===\n");

{
  const store = makeStore({
    title: "Named Session",
    label: "Named Session",
  });
  const result = await patch(store, { title: null });
  assert(result.ok === true, "clear via title: null succeeds");
  assertEq((result as any).entry.title, undefined, "title cleared");
  assertEq((result as any).entry.label, undefined, "label mirror cleared");
}

// ---------------------------------------------------------------------------
// Proof 8: legacy label: null clear
// ---------------------------------------------------------------------------

console.log("\n=== Proof 8: legacy label: null clear ===\n");

{
  const store = makeStore({
    title: "Named Session",
    label: "Named Session",
  });
  const result = await patch(store, { label: null });
  assert(result.ok === true, "clear via label: null succeeds");
  assertEq((result as any).entry.title, undefined, "title cleared");
  assertEq((result as any).entry.label, undefined, "label cleared");
}

// ---------------------------------------------------------------------------
// Proof 9: both title: null + label: null
// ---------------------------------------------------------------------------

console.log("\n=== Proof 9: both title: null + label: null ===\n");

{
  const store = makeStore({
    title: "Named Session",
    label: "Named Session",
  });
  const result = await patch(store, { title: null, label: null });
  assert(result.ok === true, "both-null clear succeeds");
  assertEq((result as any).entry.title, undefined, "title cleared");
  assertEq((result as any).entry.label, undefined, "label cleared");
}

// ---------------------------------------------------------------------------
// Proof 10: reject mixed null/string — title: null + label: string
// ---------------------------------------------------------------------------

console.log("\n=== Proof 10: reject mixed null/string ===\n");

{
  const store = makeStore({
    title: "Named Session",
    label: "Named Session",
  });

  const r1 = await patch(store, { title: null, label: "Keep This" });
  assert(r1.ok === false, "title: null + label: string → rejected");
  assert(
    !r1.ok &&
      (r1 as any).error.message.includes("cannot clear title or label while setting the other"),
    "error message mentions mixed clear/set",
  );

  const r2 = await patch(store, { title: "Keep This", label: null });
  assert(r2.ok === false, "title: string + label: null → rejected");
  assert(
    !r2.ok &&
      (r2 as any).error.message.includes("cannot clear title or label while setting the other"),
    "error message mentions mixed clear/set",
  );
}

// ---------------------------------------------------------------------------
// Proof 11: label-only set (backward compat)
// ---------------------------------------------------------------------------

console.log("\n=== Proof 11: label-only set (backward compat) ===\n");

{
  const store = makeStore();
  const result = await patch(store, { label: "Legacy Only" });
  assert(result.ok === true, "label-only set succeeds");
  assertEq((result as any).entry.label, "Legacy Only", "label set");
}

// ---------------------------------------------------------------------------
// Proof 12: title/label mismatch rejection
// ---------------------------------------------------------------------------

console.log("\n=== Proof 12: title/label mismatch rejection ===\n");

{
  const store = makeStore();
  const result = await patch(store, { title: "Alpha", label: "Beta" });
  assert(result.ok === false, "title: Alpha + label: Beta → rejected");
  assert(
    !result.ok && (result as any).error.message.includes("title and label must match"),
    "error mentions mismatch",
  );
}

// ---------------------------------------------------------------------------
// Proof 13: sessions.list — title projection from label-only entry
// ---------------------------------------------------------------------------

console.log("\n=== Proof 13: sessions.list — title projection (label-only entry) ===\n");

{
  const legacyEntry = {
    sessionId: "sess-002",
    updatedAt: 1,
    label: "Legacy Session",
  };
  assertEq(
    getSessionTitleFromEntry(legacyEntry),
    "Legacy Session",
    "label-only entry projects title from label",
  );
}

// ---------------------------------------------------------------------------
// Proof 14: sessions.resolve — title lookup matches label-only entry
// ---------------------------------------------------------------------------

console.log("\n=== Proof 14: sessions.resolve — title lookup matches label-only entry ===\n");

{
  const entry = { sessionId: "sess-003", updatedAt: 1, label: "Find Me" };
  assert(
    sessionTitlesEqual(getSessionTitleFromEntry(entry), "Find Me"),
    "title lookup matches label-only entry",
  );
}

// ---------------------------------------------------------------------------
// Proof 15: round-trip — create → rename → clear → legacy lookup
// ---------------------------------------------------------------------------

console.log("\n=== Proof 15: full round-trip — create → rename → clear → legacy lookup ===\n");

{
  // Step 1: create with title
  const store = makeStore();
  const r1 = await patch(store, { title: "Session Alpha" });
  assert(r1.ok === true, "round-trip: create succeeds");
  assertEq(
    getSessionTitleFromEntry(store["agent:main:main"]),
    "Session Alpha",
    "round-trip: title after create",
  );

  // Step 2: rename (simulates /name Beta)
  const r2 = await patch(store, { title: "Session Beta" });
  assert(r2.ok === true, "round-trip: rename succeeds");
  assertEq(store["agent:main:main"].title, "Session Beta", "round-trip: title after rename");
  assertEq(store["agent:main:main"].label, "Session Beta", "round-trip: label after rename");

  // Step 3: clear (simulates /name --clear)
  const r3 = await patch(store, { title: null });
  assert(r3.ok === true, "round-trip: clear succeeds");
  assertEq(store["agent:main:main"].title, undefined, "round-trip: title after clear");
  assertEq(store["agent:main:main"].label, undefined, "round-trip: label after clear");

  // Step 4: legacy label-only entry still resolves
  const legacyStore = makeStore({ label: "Legacy Entry" });
  assertEq(
    getSessionTitleFromEntry(legacyStore["agent:main:main"]),
    "Legacy Entry",
    "round-trip: legacy label-only resolves as title",
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n========================================");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("========================================\n");

if (failed > 0) {
  process.exit(1);
}
