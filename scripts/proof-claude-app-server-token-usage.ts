/**
 * Real-runtime behavior proof for openclaw-rw4.
 *
 * Bug: the Claude app-server runtime never captured the bridge's
 * `thread/tokenUsage/updated` notification, so `ProjectorAccumulator.usage`
 * stayed undefined, `result.attemptUsage` was never set, the run loop wrote
 * no `totalTokens` to sessions.json, and `/status` reported `0/200k`.
 *
 * This script does NOT use vitest and does NOT mock the seam under test. It
 * drives the REAL production `ClaudeAppServerEventProjector` (the class whose
 * `processNotification` / `finalize` the fix changed) through realistic
 * RPC notifications, then runs the result through the REAL session-total
 * derivation `/status` consumes (`deriveSessionTotalTokens` from
 * `src/agents/usage.ts`). The only thing stubbed is the
 * `EmbeddedRunAttemptParams` shell (the projector only reads `runId` /
 * `onAgentEvent` from it), which is not the seam under test.
 *
 * It exercises four scenarios:
 *
 *   1. Bridge reports camelCase `tokenUsage.last` (inputTokens / outputTokens
 *      / cachedInputTokens). Confirms acc.usage is populated and the derived
 *      session total (input + cacheRead) is non-zero — i.e. /status would
 *      show a real numerator instead of 0.
 *
 *   2. Bridge reports snake_case aliases at the payload top level
 *      (input_tokens / cache_read_input_tokens / cache_creation_input_tokens).
 *      Confirms alias normalization and that cacheWrite folds into the total.
 *
 *   3. Multiple `thread/tokenUsage/updated` in one turn. Confirms last-update-
 *      wins (the displayed context reflects the final API call, not the first).
 *
 *   4. No token-usage notification at all (the pre-fix steady state). Confirms
 *      acc.usage stays undefined and the derived total is undefined — proving
 *      the proof's positive scenarios aren't passing by accident.
 *
 * Run with:
 *   pnpm tsx scripts/proof-claude-app-server-token-usage.ts
 */

import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ClaudeAppServerEventProjector,
  type ProjectorAccumulator,
} from "../extensions/claude/src/app-server/event-projector.js";
import type { RpcNotification } from "../extensions/claude/src/app-server/types.js";
import { deriveSessionTotalTokens } from "../src/agents/usage.js";

const TURN_ID = "turn_proof_rw4";

function emptyAcc(): ProjectorAccumulator {
  return {
    assistantTexts: [],
    toolMetas: [],
    reasoning: "",
    itemCount: 0,
    toolCalls: new Map(),
  };
}

function makeProjector(acc: ProjectorAccumulator): ClaudeAppServerEventProjector {
  const params = {
    runId: "run_proof",
    onAgentEvent: undefined,
  } as unknown as EmbeddedRunAttemptParams;
  return new ClaudeAppServerEventProjector(TURN_ID, acc, params, {
    runId: "run_proof",
    agentId: "tank",
    sessionId: "s_proof",
    sessionKey: "agent:tank:proof",
    channelId: "proof",
  });
}

function notif(method: string, params: Record<string, unknown>): RpcNotification {
  return { jsonrpc: "2.0", method, params } as RpcNotification;
}

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

// ── Scenario 1: camelCase tokenUsage.last ─────────────────────────────────────
{
  const acc = emptyAcc();
  const projector = makeProjector(acc);
  projector.processNotification(
    notif("thread/tokenUsage/updated", {
      turnId: TURN_ID,
      tokenUsage: { last: { inputTokens: 12000, outputTokens: 800, cachedInputTokens: 4000 } },
    }),
  );
  projector.finalize();
  // input reported as uncached remainder (12000 total input - 4000 cache).
  eq(acc.usage, { input: 8000, output: 800, cacheRead: 4000 }, "S1: acc.usage from camelCase last");
  // What /status consumes: prompt-context total = input + cacheRead + cacheWrite.
  const total = deriveSessionTotalTokens({ usage: acc.usage });
  eq(total, 12000, "S1: derived session total (input+cacheRead) is non-zero");
  console.log("✓ S1 camelCase tokenUsage.last → acc.usage + derived total =", total);
}

// ── Scenario 2: snake_case aliases at top level ───────────────────────────────
{
  const acc = emptyAcc();
  const projector = makeProjector(acc);
  projector.processNotification(
    notif("thread/tokenUsage/updated", {
      turnId: TURN_ID,
      last: {
        input_tokens: 5000,
        output_tokens: 120,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 300,
      },
    }),
  );
  projector.finalize();
  eq(
    acc.usage,
    { input: 4000, output: 120, cacheRead: 1000, cacheWrite: 300 },
    "S2: acc.usage from snake_case aliases",
  );
  const total = deriveSessionTotalTokens({ usage: acc.usage });
  // input(4000) + cacheRead(1000) + cacheWrite(300)
  eq(total, 5300, "S2: derived session total includes cacheWrite");
  console.log("✓ S2 snake_case aliases → acc.usage + derived total =", total);
}

// ── Scenario 3: last-update-wins across a turn ────────────────────────────────
{
  const acc = emptyAcc();
  const projector = makeProjector(acc);
  projector.processNotification(
    notif("thread/tokenUsage/updated", {
      turnId: TURN_ID,
      tokenUsage: { last: { inputTokens: 1000, outputTokens: 10 } },
    }),
  );
  projector.processNotification(
    notif("thread/tokenUsage/updated", {
      turnId: TURN_ID,
      tokenUsage: { last: { inputTokens: 30000, outputTokens: 450 } },
    }),
  );
  projector.finalize();
  eq(acc.usage, { input: 30000, output: 450 }, "S3: latest update wins");
  const total = deriveSessionTotalTokens({ usage: acc.usage });
  eq(total, 30000, "S3: derived total reflects final API call, not the first");
  console.log("✓ S3 last-update-wins → derived total =", total);
}

// ── Scenario 4: no token-usage notification (pre-fix steady state) ────────────
{
  const acc = emptyAcc();
  const projector = makeProjector(acc);
  projector.processNotification(
    notif("item/agentMessage/delta", { turnId: TURN_ID, itemId: "m", delta: "hi" }),
  );
  projector.finalize();
  assert(acc.usage === undefined, "S4: acc.usage undefined when no token-usage notification");
  const total = deriveSessionTotalTokens({ usage: acc.usage });
  assert(total === undefined, "S4: derived total undefined — reproduces the 0/200k pre-fix state");
  console.log("✓ S4 no token-usage notification → acc.usage undefined, derived total undefined");
}

console.log("\nAll runtime assertions passed.");
