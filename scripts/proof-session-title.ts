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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type ParsedSessionTitle = { ok: true; title: string } | { ok: false; error: string };
type ParsedSessionLabel = { ok: true; label: string } | { ok: false; error: string };
type SessionTitleEntry = { title?: string; label?: string; [k: string]: unknown };

const { applySessionsPatchToStore } = await import(join(ROOT, "src/gateway/sessions-patch.js"));

const {
  applySessionTitle,
  getSessionTitleFromEntry,
  parseSessionTitle,
  parseSessionLabel,
  sessionTitlesEqual,
} = await import(join(ROOT, "src/sessions/session-label.js"));

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, msg: string) {
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

function makeStore(overrides: Record<string, unknown> = {}): Record<string, SessionTitleEntry> {
  return {
    "agent:main:main": {
      sessionId: "proof-sess-001",
      updatedAt: 1,
      ...overrides,
    },
  };
}

async function patch(store: Record<string, SessionTitleEntry>, patchData: Record<string, unknown>) {
  return applySessionsPatchToStore({
    cfg: {} as unknown as Parameters<typeof applySessionsPatchToStore>[0]["cfg"],
    store,
    storeKey: "agent:main:main",
    patch: { key: "agent:main:main", ...patchData },
  });
}

function parsedOkTitle(r: ParsedSessionTitle): string | undefined {
  return r.ok ? r.title : undefined;
}

function parsedOkLabel(r: ParsedSessionLabel): string | undefined {
  return r.ok ? r.label : undefined;
}

function parsedErrMsg(r: { ok: false; error: string }): string | undefined {
  return r.ok ? undefined : r.error;
}

console.log("\n=== Proof 1: parseSessionTitle / parseSessionLabel ===\n");

const r1 = parseSessionTitle("My Session");
assert(r1.ok === true, 'parseSessionTitle("My Session") succeeds');
assertEq(parsedOkTitle(r1), "My Session", "title value preserved");

const r2 = parseSessionTitle("  Trim Me  ");
assertEq(parsedOkTitle(r2), "Trim Me", "title is trimmed");

const r3 = parseSessionTitle("");
assert(r3.ok === false, 'parseSessionTitle("") fails');

const r4 = parseSessionTitle(null);
assert(r4.ok === false, "parseSessionTitle(null) fails");

const r5 = parseSessionTitle(123);
assert(r5.ok === false, "parseSessionTitle(123) fails");

const r6 = parseSessionLabel("Legacy Label");
assert(r6.ok === true, 'parseSessionLabel("Legacy Label") succeeds');
assertEq(parsedOkLabel(r6), "Legacy Label", "label value preserved");

const r7 = parseSessionLabel("");
assert(r7.ok === false, 'parseSessionLabel("") fails');

console.log("\n=== Proof 2: applySessionTitle — set and clear ===\n");

const entry2: SessionTitleEntry = {};
applySessionTitle(entry2, "Hello World");
assertEq(entry2.title, "Hello World", "set: title stored");
assertEq(entry2.label, "Hello World", "set: label mirror populated");

applySessionTitle(entry2, null);
assertEq(entry2.title, undefined, "clear: title removed");
assertEq(entry2.label, undefined, "clear: label mirror removed");

console.log("\n=== Proof 3: getSessionTitleFromEntry — priority ===\n");

assertEq(getSessionTitleFromEntry({ title: "A", label: "B" }), "A", "title wins over label");
assertEq(getSessionTitleFromEntry({ label: "B" }), "B", "label used when no title");
assertEq(getSessionTitleFromEntry({}), undefined, "empty entry → undefined");
assertEq(getSessionTitleFromEntry(null), undefined, "null entry → undefined");

console.log("\n=== Proof 4: sessionTitlesEqual ===\n");

assert(sessionTitlesEqual("café", "café"), "NFC-equal strings match");
assert(!sessionTitlesEqual("foo", "bar"), "different strings don't match");
assert(!sessionTitlesEqual(null, "foo"), "null left → false");
assert(!sessionTitlesEqual("foo", undefined), "undefined right → false");

console.log("\n=== Proof 5: sessions.create — set title on new session ===\n");

{
  const store = makeStore();
  const result = await patch(store, { title: "My Proof Session" });
  assert(result.ok === true, "create with title succeeds");
  const res5 = result as { ok: true; entry: SessionTitleEntry };
  assertEq(res5.entry.title, "My Proof Session", "title persisted");
  assertEq(res5.entry.label, "My Proof Session", "label mirror set");
}

console.log("\n=== Proof 6: /name <title> — rename session ===\n");

{
  const store = makeStore({ title: "Old Name", label: "Old Name" });
  const result = await patch(store, { title: "New Name" });
  assert(result.ok === true, "rename succeeds");
  const res6 = result as { ok: true; entry: SessionTitleEntry };
  assertEq(res6.entry.title, "New Name", "title updated");
  assertEq(res6.entry.label, "New Name", "label mirror updated");
}

console.log("\n=== Proof 7: /name --clear — clear via title: null ===\n");

{
  const store = makeStore({ title: "Named Session", label: "Named Session" });
  const result = await patch(store, { title: null });
  assert(result.ok === true, "clear via title: null succeeds");
  const res7 = result as { ok: true; entry: SessionTitleEntry };
  assertEq(res7.entry.title, undefined, "title cleared");
  assertEq(res7.entry.label, undefined, "label mirror cleared");
}

console.log("\n=== Proof 8: legacy label: null clear ===\n");

{
  const store = makeStore({ title: "Named Session", label: "Named Session" });
  const result = await patch(store, { label: null });
  assert(result.ok === true, "clear via label: null succeeds");
  const res8 = result as { ok: true; entry: SessionTitleEntry };
  assertEq(res8.entry.title, undefined, "title cleared");
  assertEq(res8.entry.label, undefined, "label cleared");
}

console.log("\n=== Proof 9: both title: null + label: null ===\n");

{
  const store = makeStore({ title: "Named Session", label: "Named Session" });
  const result = await patch(store, { title: null, label: null });
  assert(result.ok === true, "both-null clear succeeds");
  const res9 = result as { ok: true; entry: SessionTitleEntry };
  assertEq(res9.entry.title, undefined, "title cleared");
  assertEq(res9.entry.label, undefined, "label cleared");
}

console.log("\n=== Proof 10: reject mixed null/string ===\n");

{
  const store = makeStore({ title: "Named Session", label: "Named Session" });

  const r10a = await patch(store, { title: null, label: "Keep This" });
  assert(r10a.ok === false, "title: null + label: string → rejected");
  const msg10a = parsedErrMsg(r10a as { ok: false; error: string });
  assert(
    msg10a !== undefined && msg10a.includes("cannot clear title or label while setting the other"),
    "error message mentions mixed clear/set",
  );

  const r10b = await patch(store, { title: "Keep This", label: null });
  assert(r10b.ok === false, "title: string + label: null → rejected");
  const msg10b = parsedErrMsg(r10b as { ok: false; error: string });
  assert(
    msg10b !== undefined && msg10b.includes("cannot clear title or label while setting the other"),
    "error message mentions mixed clear/set",
  );
}

console.log("\n=== Proof 11: label-only set (backward compat) ===\n");

{
  const store = makeStore();
  const result = await patch(store, { label: "Legacy Only" });
  assert(result.ok === true, "label-only set succeeds");
  const res11 = result as { ok: true; entry: SessionTitleEntry };
  assertEq(res11.entry.label, "Legacy Only", "label set");
}

console.log("\n=== Proof 12: title/label mismatch rejection ===\n");

{
  const store = makeStore();
  const result = await patch(store, { title: "Alpha", label: "Beta" });
  assert(result.ok === false, "title: Alpha + label: Beta → rejected");
  const msg12 = parsedErrMsg(result as { ok: false; error: string });
  assert(
    msg12 !== undefined && msg12.includes("title and label must match"),
    "error mentions mismatch",
  );
}

console.log("\n=== Proof 13: sessions.list — title projection (label-only entry) ===\n");

const legacyEntry = { sessionId: "sess-002", updatedAt: 1, label: "Legacy Session" };
assertEq(
  getSessionTitleFromEntry(legacyEntry),
  "Legacy Session",
  "label-only entry projects title from label",
);

console.log("\n=== Proof 14: sessions.resolve — title lookup matches label-only entry ===\n");

const entry14 = { sessionId: "sess-003", updatedAt: 1, label: "Find Me" };
assert(
  sessionTitlesEqual(getSessionTitleFromEntry(entry14), "Find Me"),
  "title lookup matches label-only entry",
);

console.log("\n=== Proof 15: full round-trip — create → rename → clear → legacy lookup ===\n");

{
  const store = makeStore();
  const r15a = await patch(store, { title: "Session Alpha" });
  assert(r15a.ok === true, "round-trip: create succeeds");
  assertEq(
    getSessionTitleFromEntry(store["agent:main:main"]),
    "Session Alpha",
    "round-trip: title after create",
  );

  const r15b = await patch(store, { title: "Session Beta" });
  assert(r15b.ok === true, "round-trip: rename succeeds");
  assertEq(store["agent:main:main"].title, "Session Beta", "round-trip: title after rename");
  assertEq(store["agent:main:main"].label, "Session Beta", "round-trip: label after rename");

  const r15c = await patch(store, { title: null });
  assert(r15c.ok === true, "round-trip: clear succeeds");
  assertEq(store["agent:main:main"].title, undefined, "round-trip: title after clear");
  assertEq(store["agent:main:main"].label, undefined, "round-trip: label after clear");

  const legacyStore = makeStore({ label: "Legacy Entry" });
  assertEq(
    getSessionTitleFromEntry(legacyStore["agent:main:main"]),
    "Legacy Entry",
    "round-trip: legacy label-only resolves as title",
  );
}

console.log("\n========================================");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("========================================\n");

if (failed > 0) {
  process.exit(1);
}
