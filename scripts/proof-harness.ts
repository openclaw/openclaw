import { LiveSessionModelSwitchError } from "../src/agents/live-model-switch-error.js";
/**
 * Self-contained proof harness for PR #101716 fix.
 *
 * Exercises the real runWithModelFallback through two paths:
 *   1. Model-only switch (target NOT in candidates → re-throw → retry)
 *   2. Auth-profile switch (same model, different creds → re-throw → retry)
 *
 * Usage:
 *   npx tsx scripts/proof-harness.ts
 *
 * Requires: npx tsx (in project devDependencies).
 */
import { runWithModelFallback as _rf } from "../src/agents/model-fallback.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

// ── Setup (same as model-fallback.test.ts) ──────────────────────────
const emptyPlugins: never[] = [];
const rfm = <T>(p: Omit<Parameters<typeof _rf>[0], "manifestPlugins">) =>
  _rf<T>({ manifestPlugins: emptyPlugins, ...p } as Parameters<typeof _rf>[0]);
const cfg = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-4.1-mini", fallbacks: ["anthropic/claude-haiku-3-5"] },
    },
  },
} as OpenClawConfig;

// ── Verification ────────────────────────────────────────────────────
const actual = (await import("node:child_process"))
  .execSync("git rev-parse --short HEAD", { encoding: "utf8" })
  .trim();
const expected = process.env.PROOF_HEAD;
if (expected && actual !== expected) {
  console.error(`HEAD mismatch: expected ${expected}, got ${actual}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const fail = (name: string, detail: string) => {
  failed++;
  console.error(`  ❌ ${name}: ${detail}`);
};
const pass = (name: string, ms: number) => {
  passed++;
  console.log(`  ✅ ${name} (${ms}ms)`);
};

// ── Path 1: Model-only switch ───────────────────────────────────────
{
  const name = "Model switch (target NOT in candidates → re-throw → retry)";
  const t0 = Date.now();

  const switchErr = new LiveSessionModelSwitchError({
    provider: "openrouter",
    model: "deepseek-chat",
  });
  const err = await rfm<string>({
    cfg,
    provider: "openai",
    model: "gpt-4.1-mini",
    run: async () => {
      throw switchErr;
    },
    fallbacksOverride: [],
  }).catch((e: unknown) => e);

  if (!(err instanceof LiveSessionModelSwitchError)) {
    fail(name, `not LiveSessionModelSwitchError: ${String(err).slice(0, 80)}`);
  } else if ((err as LiveSessionModelSwitchError).provider !== "openrouter") {
    fail(name, "wrong provider");
  } else if ((err as LiveSessionModelSwitchError).model !== "deepseek-chat") {
    fail(name, "wrong model");
  } else {
    // Simulate outer loop retry
    const result = await rfm<string>({
      cfg,
      provider: (err as LiveSessionModelSwitchError).provider,
      model: (err as LiveSessionModelSwitchError).model,
      run: async () => "ok",
    });
    if (result.result !== "ok") {
      fail(name, "retry failed");
    } else {
      pass(name, Date.now() - t0);
    }
  }
}

// ── Path 2: Auth-profile switch (same model, set) ───────────────────
{
  const name = "Auth set (same model, re-throw → outer loop applies new creds)";
  const t0 = Date.now();

  const switchErr = new LiveSessionModelSwitchError({
    provider: "openai",
    model: "gpt-4.1-mini",
    authProfileId: "profile-b",
    authProfileIdSource: "user",
  });
  const err = await rfm<string>({
    cfg,
    provider: "openai",
    model: "gpt-4.1-mini",
    run: async () => {
      throw switchErr;
    },
    fallbacksOverride: [],
  }).catch((e: unknown) => e);

  if (!(err instanceof LiveSessionModelSwitchError)) {
    fail(name, `not LiveSessionModelSwitchError: ${String(err).slice(0, 80)}`);
  } else if ((err as LiveSessionModelSwitchError).authProfileId !== "profile-b") {
    fail(name, "authProfileId lost");
  } else if ((err as LiveSessionModelSwitchError).authProfileIdSource !== "user") {
    fail(name, "authProfileIdSource lost");
  } else {
    pass(name, Date.now() - t0);
  }
}

// ── Path 3: Auth-profile clear (same model) ─────────────────────────
{
  const name = "Auth clear (same model, re-throw → outer loop clears creds)";
  const t0 = Date.now();

  const switchErr = new LiveSessionModelSwitchError({
    provider: "openai",
    model: "gpt-4.1-mini",
    authProfileId: undefined,
    authProfileIdSource: "user",
  });
  const err = await rfm<string>({
    cfg,
    provider: "openai",
    model: "gpt-4.1-mini",
    run: async () => {
      throw switchErr;
    },
    fallbacksOverride: [],
  }).catch((e: unknown) => e);

  if (!(err instanceof LiveSessionModelSwitchError)) {
    fail(name, `not LiveSessionModelSwitchError: ${String(err).slice(0, 80)}`);
  } else if ((err as LiveSessionModelSwitchError).authProfileId !== undefined) {
    fail(name, "authProfileId should be undefined");
  } else if ((err as LiveSessionModelSwitchError).authProfileIdSource !== "user") {
    fail(name, "authProfileIdSource lost");
  } else {
    pass(name, Date.now() - t0);
  }
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n  Result: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log(`  HEAD:   ${actual}`);
process.exit(failed > 0 ? 1 : 0);
