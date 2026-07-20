// Real behavior proof for openclaw/openclaw PR #111306
// fix(ui): surface a visible error when the local user avatar fails to save (#110662)
//
// This script imports the REAL production functions from ui/src/app/settings.ts
// and ui/src/pages/config/config-page.ts (no mocks of the save path) and
// reproduces the exact failure scenario ClawSweeper asked for:
//   STEP1  storage working  -> avatar persists
//   STEP2  storage.set throwing QuotaExceededError -> visible error, prior avatar kept
//   STEP3  reload (storage still throwing) -> prior avatar preserved, alert cleared
//   STEP4  storage restored -> save succeeds, recovered
//   STEP5  reload -> recovered avatar persisted
//
// It runs under jsdom (so `localStorage` + a minimal Lit render target exist).

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// --- jsdom globals (same as vitest jsdom env) -------------------------------
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "https://control.local/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.navigator = dom.window.navigator; } catch { /* read-only in some Node versions */ }
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.customElements = dom.window.customElements;
globalThis.localStorage = dom.window.localStorage;

// --- import the REAL production code -----------------------------------------
const { saveLocalUserIdentity, loadLocalUserIdentity } = await import(
  "../../../ui/src/app/settings.ts"
);
const { ConfigPage } = await import(
  "../../../ui/src/pages/config/config-page.ts"
);

const KEY = "openclaw.control.user.v1";
const results = [];
function check(label, cond, detail) {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  :: " + detail : ""}`);
  assert.ok(cond, label + (detail ? " :: " + detail : ""));
}

// Reset storage to a known-good baseline.
localStorage.clear();
saveLocalUserIdentity({ name: null, avatar: "🦞" });

// STEP 1 — storage working
{
  const page = new ConfigPage();
  const st = page;
  check("STEP1 in-memory avatar is 🦞", st.userAvatar === "🦞", `userAvatar=${st.userAvatar}`);
  check("STEP1 no alert", st.userAvatarError === null, `error=${st.userAvatarError}`);
  check("STEP1 persisted", JSON.stringify(loadLocalUserIdentity()) === JSON.stringify({ name: null, avatar: "🦞" }),
    `persisted=${JSON.stringify(loadLocalUserIdentity())}`);
}

// STEP 2 — break localStorage.setItem, change to 🐱
{
  localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  const page = new ConfigPage();
  const st = page;
  st.setLocalUserAvatar("🐱");
  check("STEP2 in-memory avatar UNCHANGED (prior kept)", st.userAvatar === "🦞", `userAvatar=${st.userAvatar}`);
  check("STEP2 alert shown", st.userAvatarError === "QuotaExceededError", `error=${st.userAvatarError}`);
  check("STEP2 🐱 NOT persisted", loadLocalUserIdentity().avatar === "🦞",
    `persisted=${JSON.stringify(loadLocalUserIdentity())}`);
}

// STEP 3 — reload (storage still throwing on write)
{
  // Simulate a fresh page load: new ConfigPage reads persisted identity.
  const fresh = new ConfigPage();
  const st = fresh;
  check("STEP3 reload: in-memory = prior 🦞", st.userAvatar === "🦞", `userAvatar=${st.userAvatar}`);
  check("STEP3 reload: alert cleared", st.userAvatarError === null, `error=${st.userAvatarError}`);
  check("STEP3 reload: persisted still 🦞", loadLocalUserIdentity().avatar === "🦞",
    `persisted=${JSON.stringify(loadLocalUserIdentity())}`);
}

// STEP 4 — restore storage, save 🐱 again
{
  localStorage.setItem = (k, v) => dom.window.localStorage.setItem(k, v);
  const page = new ConfigPage();
  const st = page;
  st.setLocalUserAvatar("🐱");
  check("STEP4 recovered in-memory 🐱", st.userAvatar === "🐱", `userAvatar=${st.userAvatar}`);
  check("STEP4 no alert", st.userAvatarError === null, `error=${st.userAvatarError}`);
  check("STEP4 🐱 persisted", loadLocalUserIdentity().avatar === "🐱",
    `persisted=${JSON.stringify(loadLocalUserIdentity())}`);
}

// STEP 5 — reload once more
{
  const fresh = new ConfigPage();
  const st = fresh;
  check("STEP5 reload: recovered 🐱 persisted", st.userAvatar === "🐱", `userAvatar=${st.userAvatar}`);
  check("STEP5 reload: persisted 🐱", loadLocalUserIdentity().avatar === "🐱",
    `persisted=${JSON.stringify(loadLocalUserIdentity())}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length) {
  console.error("REAL BEHAVIOR PROOF FAILED");
  process.exit(1);
}
console.log("REAL BEHAVIOR PROOF PASSED");
