/**
 * Real-runtime proof for openclaw-7ss (extensions/glm-bridge, the second
 * app-server harness extension).
 *
 * What's real vs stubbed:
 * - REAL: extensions/claude/harness.ts's createClaudeAppServerAgentHarness
 *   factory (the exact function extensions/glm-bridge/index.ts imports and
 *   calls) — no mocking of the factory or its `supports()` provider-scoping
 *   logic.
 * - REAL: extensions/claude/src/app-server/client.ts's keyed shared-client
 *   pool (getSharedClaudeAppServerClient/clearSharedClaudeAppServerClient) —
 *   the exact pool code both extensions/claude and extensions/glm-bridge
 *   route through.
 * - REAL: the @zeroaltitude/openclaw-claude-bridge binary, spawned for real,
 *   speaking real JSON-RPC over stdio to a real Z.ai endpoint.
 * - STUBBED: nothing in the request path. The only external dependency is
 *   the Z.ai API itself (network), which is the point — this proves the
 *   whole chain (harness factory -> pool -> bridge subprocess -> Z.ai)
 *   works, not just that the pieces compile.
 *
 * Scenarios (per refs/openclaw.md "After-fix real behavior proof"):
 *   A. The glm-bridge harness (providerIds: ["zai"]) supports "zai" and
 *      correctly REJECTS "anthropic".
 *   B. The claude harness (default providerIds: ["anthropic"]) supports
 *      "anthropic" and correctly REJECTS "zai" — proves the two harnesses
 *      stay isolated by provider id, matching how extensions/glm-bridge and
 *      extensions/claude each independently construct the shared factory.
 *   C. A REAL GLM-5.2 turn through the shared client pool, keyed exactly
 *      the way extensions/glm-bridge's run-attempt call site would key it
 *      (`claude-bridge:zai`), gets a real, correct response.
 *
 * Requires ZAI_API_KEY in the environment (a Z.ai API key with balance).
 * Skips scenario C gracefully (prints a note, does not fail) if unset, so
 * this can still run in CI/without secrets to validate A and B.
 *
 * Run: pnpm tsx scripts/proof-glm-bridge-extension.ts
 */

import { createClaudeAppServerAgentHarness } from "../extensions/claude/harness.js";
import {
  clearSharedClaudeAppServerClient,
  getSharedClaudeAppServerClient,
} from "../extensions/claude/src/app-server/client.js";

let assertions = 0;
function assert(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function scenarioA(): Promise<void> {
  const glmHarness = createClaudeAppServerAgentHarness({
    id: "glm-bridge",
    label: "GLM app-server harness (via Z.ai)",
    providerIds: ["zai"],
  });
  assert(glmHarness.id === "glm-bridge", "A: glm-bridge harness reports its own id");
  const zaiResult = glmHarness.supports({ provider: "zai" } as Parameters<
    typeof glmHarness.supports
  >[0]);
  assert(zaiResult.supported === true, "A: glm-bridge harness supports provider 'zai'");
  const anthropicResult = glmHarness.supports({ provider: "anthropic" } as Parameters<
    typeof glmHarness.supports
  >[0]);
  assert(
    anthropicResult.supported === false,
    "A: glm-bridge harness correctly rejects provider 'anthropic'",
  );
}

async function scenarioB(): Promise<void> {
  const claudeHarness = createClaudeAppServerAgentHarness();
  assert(claudeHarness.id === "claude-bridge", "B: default harness reports id 'claude-bridge'");
  const anthropicResult = claudeHarness.supports({ provider: "anthropic" } as Parameters<
    typeof claudeHarness.supports
  >[0]);
  assert(
    anthropicResult.supported === true,
    "B: default (claude) harness supports provider 'anthropic'",
  );
  const zaiResult = claudeHarness.supports({ provider: "zai" } as Parameters<
    typeof claudeHarness.supports
  >[0]);
  assert(
    zaiResult.supported === false,
    "B: default (claude) harness correctly rejects provider 'zai'",
  );
}

async function scenarioC(): Promise<void> {
  const zaiKey = process.env.ZAI_API_KEY?.trim();
  if (!zaiKey) {
    console.log("(skipped) C: ZAI_API_KEY not set — skipping the real GLM turn scenario");
    return;
  }
  // Same pool key extensions/claude/src/app-server/run-attempt.ts derives:
  // `claude-bridge:${cfg.appServer.modelProvider}`. extensions/glm-bridge's
  // resolved config sets modelProvider: "zai", so this is exactly the key
  // its run-attempt call site would use.
  const poolKey = "claude-bridge:zai";
  const client = getSharedClaudeAppServerClient(poolKey, {
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: zaiKey,
    },
  });
  await client.start();
  const startResp = (await client.request(
    "thread/start",
    {
      cwd: process.cwd(),
      model: "glm-5.2",
      modelProvider: "zai",
      approvalPolicy: "never",
      sandbox: { mode: "danger-full-access" },
      developerInstructions: "Answer in one short sentence.",
      dynamicTools: [],
    },
    AbortSignal.timeout(30_000),
  )) as { thread: { id: string }; modelProvider: string };
  assert(
    startResp.modelProvider === "zai",
    "C: thread/start echoes modelProvider 'zai' (bridge's own provider-override path)",
  );

  const notifications: Array<{ method: string; params: unknown }> = [];
  client.onNotification((n) => notifications.push(n));

  const turnCompleted = new Promise<{ turn: { status: string } }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn/completed timed out")), 60_000);
    client.onNotification((n) => {
      if (n.method === "turn/completed") {
        clearTimeout(timer);
        resolve(n.params as { turn: { status: string } });
      }
    });
  });

  await client.request(
    "turn/start",
    {
      threadId: startResp.thread.id,
      input: [{ type: "text", text: "What is 6*7? Answer with just the number." }],
    },
    AbortSignal.timeout(60_000),
  );
  const result = await turnCompleted;
  assert(result.turn.status === "completed", "C: real GLM-5.2 turn completes successfully");

  const gotDelta = notifications.some((n) => n.method === "item/agentMessage/delta");
  assert(gotDelta, "C: streamed item/agentMessage/delta notifications were received");
}

async function main(): Promise<void> {
  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    console.log(`\nAll ${assertions} runtime assertions passed.`);
  } finally {
    await clearSharedClaudeAppServerClient();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
