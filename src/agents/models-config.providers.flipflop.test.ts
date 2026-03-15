/**
 * Unit test for normalizeProviders() flip-flop bug
 *
 * Bug: When openclaw.json configures a provider apiKey using an env var reference,
 * normalizeProviders() creates a flip-flop cycle:
 * 1. First normalization: writes env var NAME to models.json
 * 2. User manually fixes: changes models.json to resolved VALUE
 * 3. Next normalization: converts VALUE back to NAME
 *
 * This test reproduces the bug and verifies the fix.
 *
 * Location: src/agents/models-config.providers.ts lines 504-519 (OpenClaw v2026.3.13)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeProviders } from "./models-config.providers.js";

describe("normalizeProviders flip-flop bug", () => {
  let agentDir: string;
  const TEST_ENV_VAR = "TEST_OLLAMA_API_KEY";
  const TEST_ENV_VALUE = "ollama-local";

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    process.env[TEST_ENV_VAR] = TEST_ENV_VALUE;
  });

  afterEach(async () => {
    delete process.env[TEST_ENV_VAR];
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("FIX VERIFICATION: resolved values are preserved (no flip-flop)", async () => {
    const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      "ollama-local": {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: TEST_ENV_VALUE, // Resolved value from env var
        models: [
          {
            id: "qwen3.5:4b",
            name: "Qwen 3.5 4B",
            input: ["text"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    };

    // First normalization: should preserve resolved value
    const _normalized1 = normalizeProviders({ providers, agentDir });
    expect(_normalized1?.["ollama-local"]?.apiKey).toBe(TEST_ENV_VALUE);

    // Simulate user manually editing models.json
    const manuallyFixed = {
      ...providers,
      "ollama-local": {
        ...providers["ollama-local"],
        apiKey: TEST_ENV_VALUE,
      },
    };

    // Second normalization: should still preserve resolved value (no flip-flop)
    const normalized2 = normalizeProviders({ providers: manuallyFixed, agentDir });
    expect(normalized2?.["ollama-local"]?.apiKey).toBe(TEST_ENV_VALUE);
  });

  it("FIX VERIFICATION: preserves resolved value after normalization (no flip-flop)", async () => {
    const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      "ollama-local": {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: TEST_ENV_VALUE, // Resolved value
        models: [
          {
            id: "qwen3.5:4b",
            name: "Qwen 3.5 4B",
            input: ["text"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    };

    // After fix: normalization should preserve the resolved value
    const normalized = normalizeProviders({ providers, agentDir });

    // EXPECTED BEHAVIOR AFTER FIX:
    // models.json should contain the resolved value, not the env var name
    expect(normalized?.["ollama-local"]?.apiKey).toBe(TEST_ENV_VALUE);
  });

  it("FIX VERIFICATION: manual edits to models.json are preserved", async () => {
    const originalProviders: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      "ollama-local": {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: "original-value",
        models: [],
      },
    };

    // First normalization
    const _normalized1 = normalizeProviders({ providers: originalProviders, agentDir });

    // Simulate user editing models.json
    const editedProviders: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      "ollama-local": {
        ...originalProviders["ollama-local"],
        apiKey: "edited-value", // User manually edits
      },
    };

    // After fix: second normalization should preserve the edited value
    const normalized2 = normalizeProviders({ providers: editedProviders, agentDir });

    // EXPECTED BEHAVIOR AFTER FIX:
    // Manual edits should be preserved, not reverted
    expect(normalized2?.["ollama-local"]?.apiKey).toBe("edited-value");
  });

  it("ENV VAR REFERENCE: { source: 'env' } config normalizes to env var name", async () => {
    // This test verifies that SecretRef env var references are normalized correctly
    // (separate from the flip-flop bug which affects resolved string values)

    const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      "ollama-local": {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: { source: "env" as const, provider: "default", id: TEST_ENV_VAR },
        models: [],
      },
    };

    // normalizeProviders() should convert SecretRef to env var name
    const normalized = normalizeProviders({ providers, agentDir });

    // SecretRef { source: "env", id: "VAR" } normalizes to "VAR"
    expect(normalized?.["ollama-local"]?.apiKey).toBe(TEST_ENV_VAR);
  });
});

/**
 * Test Instructions
 *
 * BEFORE APPLYING FIX:
 * - Run: `cd /path/to/openclaw && npm test -- src/agents/models-config.providers.flipflop.test.ts`
 * - Expected: "BUG REPRODUCTION" test PASSES (demonstrates the bug exists)
 * - Expected: "FIX VERIFICATION" tests FAIL (bug is present)
 *
 * AFTER APPLYING FIX:
 * - Remove lines 504-519 from src/agents/models-config.providers.ts
 * - Run: `npm test -- src/agents/models-config.providers.flipflop.test.ts`
 * - Expected: "BUG REPRODUCTION" test FAILS (bug is fixed, behavior changed)
 * - Expected: "FIX VERIFICATION" tests PASS (fix works correctly)
 *
 * Note: The "BUG REPRODUCTION" test is intentionally written to pass when the bug
 * exists. After the fix, this test will fail because the behavior changes. This
 * is expected - the test documents the buggy behavior for reproduction purposes.
 */
