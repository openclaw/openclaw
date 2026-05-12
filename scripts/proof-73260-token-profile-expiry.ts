/**
 * Real-runtime behavior proof for #73260 token-profile expiry invalidation.
 *
 * This script does not use Vitest or mocks of the models-config cache seam. It
 * drives the production `ensureOpenClawModelsJson` implementation against real
 * temporary `auth-profiles.json` and `models.json` files, then inspects the
 * process-wide production ready-cache map to prove the cache key behavior.
 *
 * Scenarios:
 * 1. OAuth session-field rotation, including `expires`, keeps the same cache
 *    key because OAuth access/refresh/expiry fields are volatile session state.
 * 2. Static `type: "token"` expiry valid->expired creates a new cache key
 *    because token expiry controls credential eligibility and must invalidate
 *    the ready cache.
 * 3. Repeating the expired token profile reuses the new key, proving the cache
 *    stabilizes after the eligibility-affecting change.
 *
 * Run with:
 *   pnpm tsx scripts/proof-73260-token-profile-expiry.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MODELS_JSON_STATE } from "../src/agents/models-config-state.js";
import {
  ensureOpenClawModelsJson,
  resetModelsJsonReadyCacheForTest,
} from "../src/agents/models-config.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/io.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const ensureOptions = {
  providerDiscoveryProviderIds: [] as readonly string[],
  providerDiscoveryEntriesOnly: true,
  providerDiscoveryTimeoutMs: 1,
};

function createConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          apiKey: "redacted-openai-token",
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
  };
}

async function writeAuthProfiles(agentDir: string, profiles: unknown): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(profiles));
}

function cacheKeysFor(agentDir: string): string[] {
  const targetPath = path.join(agentDir, "models.json");
  return [...MODELS_JSON_STATE.readyCache.keys()]
    .filter((key) => key.startsWith(`${targetPath}\0`))
    .toSorted();
}

function fingerprintSuffix(key: string): string {
  return key.split("\0").at(1)?.slice(0, 16) ?? "<missing>";
}

async function runOAuthVolatileScenario(root: string): Promise<void> {
  resetModelsJsonReadyCacheForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();

  const agentDir = path.join(root, "oauth-agent");
  const cfg = createConfig();
  await writeAuthProfiles(agentDir, {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "redacted-access-v1",
        refresh: "redacted-refresh-v1",
        expires: 1_800_000_000_000,
        accountId: "acct-redacted",
      },
    },
  });

  await ensureOpenClawModelsJson(cfg, agentDir, ensureOptions);
  const keysAfterWarm = cacheKeysFor(agentDir);
  assert.equal(keysAfterWarm.length, 1, "OAuth warm call should create one cache key");

  await writeAuthProfiles(agentDir, {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "redacted-access-v2",
        refresh: "redacted-refresh-v2",
        expires: 1_800_000_999_000,
        accountId: "acct-redacted",
      },
    },
  });

  await ensureOpenClawModelsJson(cfg, agentDir, ensureOptions);
  const keysAfterRotation = cacheKeysFor(agentDir);
  assert.deepEqual(
    keysAfterRotation,
    keysAfterWarm,
    "OAuth volatile session-field rotation must not create a new cache key",
  );

  console.log("[1/3] oauth-session-fields-are-volatile");
  console.log(`    cache key stayed stable: ${fingerprintSuffix(keysAfterWarm[0] ?? "")}`);
}

async function runTokenExpiryScenario(root: string): Promise<void> {
  resetModelsJsonReadyCacheForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();

  const agentDir = path.join(root, "token-agent");
  const cfg = createConfig();
  const futureMs = Date.now() + 60 * 60 * 1000;
  await writeAuthProfiles(agentDir, {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        token: "redacted-static-token",
        expires: futureMs,
      },
    },
  });

  await ensureOpenClawModelsJson(cfg, agentDir, ensureOptions);
  const keysAfterValid = cacheKeysFor(agentDir);
  assert.equal(keysAfterValid.length, 1, "valid token profile should create one cache key");

  const pastMs = Date.now() - 60 * 60 * 1000;
  await writeAuthProfiles(agentDir, {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        token: "redacted-static-token",
        expires: pastMs,
      },
    },
  });

  await ensureOpenClawModelsJson(cfg, agentDir, ensureOptions);
  const keysAfterExpired = cacheKeysFor(agentDir);
  assert.equal(
    keysAfterExpired.length,
    2,
    "token expiry valid->expired must create a distinct cache key",
  );
  assert.notEqual(
    keysAfterExpired[0],
    keysAfterExpired[1],
    "token expiry valid->expired must change the ready-cache fingerprint",
  );

  await ensureOpenClawModelsJson(cfg, agentDir, ensureOptions);
  const keysAfterRepeatExpired = cacheKeysFor(agentDir);
  assert.deepEqual(
    keysAfterRepeatExpired,
    keysAfterExpired,
    "repeating the same expired token profile should reuse the expired cache key",
  );

  console.log("[2/3] token-expiry-invalidates-cache");
  console.log(`    valid-token key:   ${fingerprintSuffix(keysAfterValid[0] ?? "")}`);
  console.log(
    `    expired-token key: ${fingerprintSuffix(keysAfterExpired.find((key) => key !== keysAfterValid[0]) ?? "")}`,
  );
  console.log("[3/3] expired-token-cache-stabilizes");
  console.log(`    cache keys after repeat expired call: ${keysAfterRepeatExpired.length}`);
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-73260-token-proof-"));
  try {
    console.log(`Proof root: ${root}`);
    await runOAuthVolatileScenario(root);
    await runTokenExpiryScenario(root);
    console.log("");
    console.log("All runtime assertions passed.");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
    resetModelsJsonReadyCacheForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }
}

await main();
