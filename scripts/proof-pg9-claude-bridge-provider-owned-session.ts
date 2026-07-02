/**
 * Real-runtime behavior proof for openclaw-pg9.
 *
 * Bug: Claude app-server bridge sessions never populated
 * `entry.cliSessionBindings`, so `hasProviderOwnedSession()` returned false for
 * them and the gateway's daily *default* reset (resetPolicy.configured !== true)
 * wiped active bridge sessions — even while they were being actively worked —
 * instead of exempting them the way a genuinely provider-owned session should be.
 *
 * Root cause (see fix-report): the freshness exemption
 * (`src/config/sessions/entry-freshness.ts`) keys on `cliSessionBindings`, which
 * only the legacy text-only CLI runner wrote. The app-server bridge runs through
 * the embedded-agent runner and its `providerUsed` is the *vendor* id
 * "anthropic", which never matches a registered CLI backend id ("claude-cli"),
 * so `isCliProvider("anthropic")` is false and the auto-reply persistence path
 * skipped writing any binding. The bridge's durable resumable thread lives in
 * its own sidecar store, so the gateway had no signal the session was
 * provider-owned.
 *
 * Fix: the claude consumer surfaces the bridge `threadId` as
 * `agentMeta.cliSessionBinding`, and the auto-reply persistence gate persists an
 * explicit runner-provided binding regardless of `isCliProvider`.
 *
 * This script does NOT use vitest and does NOT mock the seam under test. It
 * drives the REAL production code the fix touches / relies on:
 *   - REAL `isCliProvider` (src/agents/model-selection-cli.ts)
 *   - REAL `persistRunSessionUsage` → `persistSessionUsageUpdate` write path
 *     against a REAL on-disk session store in a temp dir
 *   - REAL `loadSessionEntry` re-read from disk
 *   - REAL `hasProviderOwnedSession` + `resolveSessionEntryResetFreshness`
 *     (the exact freshness/reset code the daily reset consults)
 * The only thing replicated (not mocked) is the tiny boolean gate expression
 * lifted verbatim from `src/auto-reply/reply/agent-runner.ts` (which is not
 * standalone-drivable); it is exercised with the REAL `isCliProvider`.
 *
 * Three scenarios:
 *   A. Claude-bridge turn surfaces a binding → after persist the session has
 *      `cliSessionBindings.anthropic.sessionId`, `hasProviderOwnedSession` is
 *      true, and the session is FRESH (exempt) under the default daily reset —
 *      whereas before persist it was STALE (would be wiped). The fix.
 *   B. Anthropic turn that surfaces NO binding (pre-fix steady state) → no
 *      binding written, not provider-owned, STALE under the daily reset.
 *      Reproduces the bug and pins that we did NOT start blanket-writing
 *      bindings for every anthropic turn.
 *   C. Legacy CLI provider ("claude-cli", isCliProvider true) with only
 *      `agentMeta.sessionId` → the cliSessionId fallback still writes
 *      `cliSessionBindings["claude-cli"]` and the session stays provider-owned.
 *      Pins that the gate change did not regress the legacy path.
 *
 * Run with:
 *   pnpm tsx scripts/proof-pg9-claude-bridge-provider-owned-session.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCliProvider } from "../src/agents/model-selection-cli.js";
import type { CliSessionBinding } from "../src/config/sessions/types.js";
import {
  hasProviderOwnedSession,
  resolveSessionEntryResetFreshness,
} from "../src/config/sessions/entry-freshness.js";
import { loadSessionEntry } from "../src/config/sessions/session-accessor.js";
import { upsertSessionEntry } from "../src/config/sessions/store.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import { persistRunSessionUsage } from "../src/auto-reply/reply/session-run-accounting.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const NOW = Date.parse("2026-07-02T12:00:00Z");
const OLD_STARTED_AT = NOW - 48 * 60 * 60 * 1000; // 2 days old → before last daily reset boundary.

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

function eq(a: unknown, b: unknown, msg: string): void {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
  );
}

/**
 * Replicates the persistence gate verbatim from
 * src/auto-reply/reply/agent-runner.ts (post-fix), driven by the REAL
 * isCliProvider. Returns the {cliSessionId, cliSessionBinding} the auto-reply
 * path would feed to persistRunSessionUsage for one completed turn.
 */
function agentRunnerGate(params: {
  providerUsed: string;
  cfg: OpenClawConfig;
  agentMeta: { sessionId?: string; cliSessionBinding?: CliSessionBinding };
}): { cliSessionId?: string; cliSessionBinding?: CliSessionBinding } {
  const usedCliProvider = isCliProvider(params.providerUsed, params.cfg);
  const runnerCliSessionBinding = params.agentMeta.cliSessionBinding;
  const cliSessionId = usedCliProvider
    ? normalizeOptionalString(params.agentMeta.sessionId)
    : undefined;
  const cliSessionBinding =
    usedCliProvider || runnerCliSessionBinding ? runnerCliSessionBinding : undefined;
  return { cliSessionId, cliSessionBinding };
}

function freshnessState(storePath: string, sessionKey: string): "fresh" | "stale" | "missing" {
  return resolveSessionEntryResetFreshness({
    storePath,
    sessionKey,
    resetType: "direct",
    // sessionCfg omitted → default daily reset, resetPolicy.configured === false
    // (exactly the "daily 4am default reset" case this bug is about).
    now: NOW,
  }).state;
}

async function seedEntry(
  storePath: string,
  sessionKey: string,
  fields: Partial<SessionEntry>,
): Promise<void> {
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: sessionKey,
      sessionStartedAt: OLD_STARTED_AT,
      updatedAt: OLD_STARTED_AT,
      ...fields,
    } as SessionEntry,
    skipMaintenance: true,
  });
}

const dir = mkdtempSync(join(tmpdir(), "pg9-proof-"));
const storePath = join(dir, "sessions.json");

// A default config with NO CLI backends configured: isCliProvider("anthropic")
// must be false here (mirrors the real gateway, where "anthropic" is a vendor,
// not a CLI backend id).
const defaultCfg = { agents: { defaults: { cliBackends: {} } } } as unknown as OpenClawConfig;
// A config where "claude-cli" IS a configured CLI backend id (legacy path).
const cliCfg = {
  agents: { defaults: { cliBackends: { "claude-cli": {} } } },
} as unknown as OpenClawConfig;

try {
  // ── Scenario A: the fix ────────────────────────────────────────────────────
  {
    const sessionKey = "agent:tank:proof-pg9-A";
    const THREAD_ID = "thread_pg9_abc123"; // the bridge's durable resumable thread id
    await seedEntry(storePath, sessionKey, {
      modelProvider: "anthropic",
      agentHarnessId: "claude-bridge",
    });

    // Pre-fix / pre-persist state reproduces the bug.
    assert(
      isCliProvider("anthropic", defaultCfg) === false,
      "A: isCliProvider('anthropic') is false (anthropic is a vendor, not a CLI backend id)",
    );
    const preEntry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    assert(preEntry !== undefined, "A: seeded entry loads");
    assert(
      hasProviderOwnedSession(preEntry) === false,
      "A: pre-persist NOT provider-owned (no cliSessionBindings)",
    );
    eq(freshnessState(storePath, sessionKey), "stale", "A: pre-persist STALE under daily reset");

    // A completed claude-bridge turn now surfaces the threadId as the binding.
    const gate = agentRunnerGate({
      providerUsed: "anthropic",
      cfg: defaultCfg,
      agentMeta: { sessionId: sessionKey, cliSessionBinding: { sessionId: THREAD_ID } },
    });
    assert(
      gate.cliSessionBinding?.sessionId === THREAD_ID,
      "A: gate lets the runner-provided binding through despite isCliProvider=false",
    );
    assert(gate.cliSessionId === undefined, "A: cliSessionId fallback stays gated off for anthropic");

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      cfg: defaultCfg,
      providerUsed: "anthropic",
      modelUsed: "claude-opus-4-8",
      usage: { input: 1200, output: 200 },
      contextTokensUsed: 1_000_000,
      cliSessionId: gate.cliSessionId,
      cliSessionBinding: gate.cliSessionBinding,
    });

    const postEntry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    assert(postEntry !== undefined, "A: entry reloads after persist");
    eq(
      postEntry?.cliSessionBindings?.anthropic?.sessionId,
      THREAD_ID,
      "A: cliSessionBindings.anthropic.sessionId is the bridge threadId",
    );
    assert(
      hasProviderOwnedSession(postEntry) === true,
      "A: post-persist IS provider-owned",
    );
    eq(
      freshnessState(storePath, sessionKey),
      "fresh",
      "A: post-persist FRESH — exempt from the daily default reset",
    );
    console.log("✓ A claude-bridge turn → binding persisted, session provider-owned & reset-exempt");
  }

  // ── Scenario B: regression pin (no binding surfaced) ────────────────────────
  {
    const sessionKey = "agent:tank:proof-pg9-B";
    await seedEntry(storePath, sessionKey, {
      modelProvider: "anthropic",
      agentHarnessId: "claude-bridge",
    });
    const gate = agentRunnerGate({
      providerUsed: "anthropic",
      cfg: defaultCfg,
      agentMeta: { sessionId: sessionKey }, // no cliSessionBinding (pre-fix runner)
    });
    assert(gate.cliSessionBinding === undefined, "B: no binding flows");
    assert(gate.cliSessionId === undefined, "B: no cliSessionId flows for anthropic");

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      cfg: defaultCfg,
      providerUsed: "anthropic",
      modelUsed: "claude-opus-4-8",
      usage: { input: 1200, output: 200 },
      contextTokensUsed: 1_000_000,
      cliSessionId: gate.cliSessionId,
      cliSessionBinding: gate.cliSessionBinding,
    });

    const postEntry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    assert(
      postEntry?.cliSessionBindings === undefined,
      "B: NO cliSessionBindings written (we did not blanket-write for anthropic)",
    );
    assert(
      hasProviderOwnedSession(postEntry) === false,
      "B: NOT provider-owned without a surfaced binding",
    );
    eq(
      freshnessState(storePath, sessionKey),
      "stale",
      "B: STALE — reproduces the bug; the fix is load-bearing",
    );
    console.log("✓ B anthropic turn without a surfaced binding → still stale (bug reproduces)");
  }

  // ── Scenario C: legacy CLI path unbroken ────────────────────────────────────
  {
    const sessionKey = "agent:tank:proof-pg9-C";
    const CLI_SESSION_ID = "claude-cli-sess-xyz";
    await seedEntry(storePath, sessionKey, { modelProvider: "claude-cli" });

    assert(
      isCliProvider("claude-cli", cliCfg) === true,
      "C: isCliProvider('claude-cli') is true when configured as a CLI backend",
    );
    const gate = agentRunnerGate({
      providerUsed: "claude-cli",
      cfg: cliCfg,
      agentMeta: { sessionId: CLI_SESSION_ID }, // legacy runner sets sessionId, not a binding
    });
    eq(gate.cliSessionId, CLI_SESSION_ID, "C: cliSessionId fallback flows for a CLI provider");
    assert(gate.cliSessionBinding === undefined, "C: no explicit binding on the legacy path");

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      cfg: cliCfg,
      providerUsed: "claude-cli",
      modelUsed: "claude-opus-4-8",
      usage: { input: 900, output: 100 },
      contextTokensUsed: 1_000_000,
      cliSessionId: gate.cliSessionId,
      cliSessionBinding: gate.cliSessionBinding,
    });

    const postEntry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    eq(
      postEntry?.cliSessionBindings?.["claude-cli"]?.sessionId,
      CLI_SESSION_ID,
      "C: legacy cliSessionId still lands as a binding",
    );
    assert(
      hasProviderOwnedSession(postEntry) === true,
      "C: legacy CLI session stays provider-owned (no regression)",
    );
    eq(freshnessState(storePath, sessionKey), "fresh", "C: legacy CLI session stays reset-exempt");
    console.log("✓ C legacy claude-cli path unbroken → binding persisted, still reset-exempt");
  }

  console.log("\nAll runtime assertions passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
