#!/usr/bin/env node
/**
 * Live repro for PR #91359: Codex app inventory refresh failure returns a
 * diagnostic snapshot instead of throwing, so the harness turn can continue.
 *
 * Run: pnpm exec tsx scripts/repro/91359-codex-app-list-failure-proof.mts
 */
import { CodexAppInventoryCache } from "../../extensions/codex/src/app-server/app-inventory-cache.ts";

async function main() {
  const cache = new CodexAppInventoryCache({ ttlMs: 1000 });
  const key = "runtime";

  console.log("=== PR #91359 Codex app/list failure proof ===\n");

  const snapshot = await cache.refreshNow({
    key,
    nowMs: 0,
    request: async () => {
      throw new Error("simulated app/list failure");
    },
  });

  console.log("refreshNow returned (did not throw):", true);
  console.log("snapshot.lastError:", snapshot.lastError?.message);
  console.log("snapshot.apps:", snapshot.apps);
  console.log("snapshot.expiresAtMs:", snapshot.expiresAtMs);

  const read = cache.read({
    key,
    nowMs: 0,
    request: async () => ({ data: [], nextCursor: null }),
  });

  console.log("cache.read state:", read.state);
  console.log("cache.read diagnostic:", read.diagnostic?.message);

  const pass =
    snapshot.lastError?.message === "simulated app/list failure" &&
    snapshot.apps.length === 0 &&
    read.state === "missing" &&
    read.diagnostic?.message === "simulated app/list failure";

  console.log(pass ? "\nPASS: failure handled gracefully." : "\nFAIL: unexpected behavior.");
  process.exit(pass ? 0 : 1);
}

main();
