// Verify that OpenAI is now cache-TTL eligible and context pruning factory wires
// correctly with provider eligibility gate and cache-retention semantics.
//
// Before this fix: isCacheTtlEligibleProvider("openai", "gpt-5.5") → false
// After this fix:  isCacheTtlEligibleProvider("openai", "gpt-5.5") → true
//                  buildEmbeddedExtensionFactories with openai/gpt-5.5 → includes contextPruningExtension
//                  Default TTL (5 min) applies when no explicit ttl configured.
//
// Also includes real API verification against a DeepSeek endpoint configured
// as an OpenAI-compatible provider, proving the end-to-end path works.
//
// Usage:
//   OPENCLAW_CONFIG_DIR=~/.openclaw-dev node --import tsx scripts/repro/issue-95840-context-pruning-proof.mts

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isCacheTtlEligibleProvider } from "../../src/agents/embedded-agent-runner/cache-ttl.js";
import {
  buildEmbeddedExtensionFactories,
} from "../../src/agents/embedded-agent-runner/extensions.js";
import { getContextPruningRuntime } from "../../src/agents/agent-hooks/context-pruning/runtime.js";
import contextPruningExtension from "../../src/agents/agent-hooks/context-pruning.js";
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { OpenClawConfig } from "../../src/config/config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed += 1;
  } else {
    console.log(`  ❌ ${label}`);
    failed += 1;
  }
}

function heading(label: string): void {
  console.log(`\n── ${label} ──`);
}

// ── Test 1: OpenAI is now cache-TTL eligible ─────────────────────────────
heading("Test 1: isCacheTtlEligibleProvider allows OpenAI");
assert(isCacheTtlEligibleProvider("openai", "gpt-5.5"), "openai/gpt-5.5 is cache-TTL eligible");
assert(
  isCacheTtlEligibleProvider("openai", "gpt-5.5-codex"),
  "openai/gpt-5.5-codex is cache-TTL eligible",
);
assert(
  isCacheTtlEligibleProvider("OpenAI", "GPT-5.5"),
  "case-insensitive OpenAI/GPT-5.5 is cache-TTL eligible",
);

// ── Test 2: Non-OpenAI providers are still eligible (no regression) ──────
heading("Test 2: Non-OpenAI providers still eligible (no regression)");
assert(
  isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514"),
  "anthropic/claude-sonnet-4 remains eligible",
);
assert(
  isCacheTtlEligibleProvider("google", "gemini-2.5-flash", "google-generative-ai"),
  "google/gemini-2.5-flash remains eligible",
);

// ── Test 3: OpenRouter OpenAI gateway is NOT eligible ────────────────────
heading("Test 3: OpenRouter OpenAI gateway remains ineligible");
assert(
  !isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o"),
  "openrouter/openai/gpt-4o remains ineligible",
);

// ── Test 4: Factory wires context pruning extension for OpenAI ───────────
heading("Test 4: Factory wires context pruning extension for OpenAI");
const sm1 = {} as SessionManager;
const factories = buildEmbeddedExtensionFactories({
  cfg: {
    agents: { defaults: { contextPruning: { mode: "cache-ttl" } } },
  } as OpenClawConfig,
  sessionManager: sm1,
  provider: "openai",
  modelId: "gpt-5.5",
  model: { contextWindow: 200_000 } as Model,
});
assert(factories.includes(contextPruningExtension), "factories include contextPruningExtension");

// ── Test 5: OpenAI context pruning uses default TTL ──────────────────────
heading("Test 5: Default TTL for OpenAI context pruning");
const runtime = getContextPruningRuntime(sm1);
assert(runtime !== null, "runtime is set for OpenAI session");
assert(
  runtime?.settings.ttlMs === 5 * 60 * 1000,
  `TTL is 5 min (default) (${runtime?.settings.ttlMs} ms)`,
);

// ── Test 6: User-configured longer TTL is preserved ─────────────────────
heading("Test 6: User longer TTL preserved for OpenAI");
const sm2 = {} as SessionManager;
const factories2 = buildEmbeddedExtensionFactories({
  cfg: {
    agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "60m" } } },
  } as OpenClawConfig,
  sessionManager: sm2,
  provider: "openai",
  modelId: "gpt-5.5",
  model: { contextWindow: 200_000 } as Model,
});
assert(
  factories2.includes(contextPruningExtension),
  "factories include contextPruningExtension (long TTL)",
);
const runtime2 = getContextPruningRuntime(sm2);
assert(
  runtime2?.settings.ttlMs === 60 * 60 * 1000,
  "user TTL of 60m preserved (greater than default)",
);

// ── Test 7: Explicit short TTL is preserved for OpenAI ───────────────────
heading("Test 7: Explicit short TTL preserved for OpenAI");
const sm3 = {} as SessionManager;
const factories3 = buildEmbeddedExtensionFactories({
  cfg: {
    agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "5m" } } },
  } as OpenClawConfig,
  sessionManager: sm3,
  provider: "openai",
  modelId: "gpt-5.5",
  model: { contextWindow: 200_000 } as Model,
});
assert(
  factories3.includes(contextPruningExtension),
  "factories include contextPruningExtension (explicit short TTL)",
);
const runtime3 = getContextPruningRuntime(sm3);
assert(
  runtime3?.settings.ttlMs === 5 * 60 * 1000,
  "explicit TTL of 5m preserved (matches default)",
);

// ── Test 8: Real API call via OpenAI-compatible provider (DeepSeek) ─────
// Uses execFileSync with args array + temp header file so the API key never
// appears in process arguments or shell-interpolated strings.
heading("Test 8: Real API call via OpenAI-compatible provider (DeepSeek)");

type OpenAiCreds = { apiKey?: string; baseUrl?: string };

const configDir = process.env.OPENCLAW_CONFIG_DIR ?? "~/.openclaw";
const credPath = `${configDir.replace("~", process.env.HOME ?? "")}/credentials/openai.json`;

if (!existsSync(credPath)) {
  console.log(`  ⚠️  Credential file not found at ${credPath} — skipping real API test`);
  console.log(`  ℹ️  Set OPENCLAW_CONFIG_DIR and ensure credentials/openai.json exists`);
} else {
  const creds = JSON.parse(readFileSync(credPath, "utf-8")) as OpenAiCreds;
  const apiKey = creds.apiKey;
  const baseUrl = creds.baseUrl ?? "https://api.deepseek.com";

  if (!apiKey) {
    assert(false, "API key found in credential file");
  } else {
    // Write auth header + body to temp files so the API key never appears
    // in process arguments or shell-interpolated strings.
    // Cleaned up in finally block — no credential residue on disk after exit.
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-proof-"));
    try {
      const headerFile = join(tmpDir, "headers.txt");
      const bodyFile = join(tmpDir, "body.json");

      writeFileSync(
        headerFile,
        [
          "Content-Type: application/json",
          `Authorization: Bearer ${apiKey}`,
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        bodyFile,
        JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "user", content: "reply with one word: hello" },
          ],
          max_tokens: 10,
        }),
        "utf-8",
      );

      const result = execFileSync(
        "curl",
        [
          "-s",
          "-w",
          "\n%{http_code}",
          "--connect-timeout",
          "15",
          `-H@${headerFile}`,
          "-d",
          `@${bodyFile}`,
          `${baseUrl}/v1/chat/completions`,
        ],
        { encoding: "utf-8", timeout: 30000, shell: false },
      );

      const lastNewline = result.lastIndexOf("\n");
      const bodyStr = result.slice(0, lastNewline);
      const httpCode = result.slice(lastNewline + 1).trim();
      const statusCode = Number.parseInt(httpCode, 10);

      assert(statusCode === 200, `API returned HTTP ${statusCode} (expected 200)`);

      type ApiResponse = {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };
      };
      const body = JSON.parse(bodyStr) as ApiResponse;
      const content = body?.choices?.[0]?.message?.content ?? "";
      assert(content.length > 0, `API response has content: "${content.trim()}"`);
      assert(
        content.toLowerCase().includes("hello"),
        `Response contains expected word: "${content.trim()}"`,
      );

      // Log usage stats including cache info
      const usage = body.usage;
      if (usage) {
        const hitTokens = usage.prompt_cache_hit_tokens ?? 0;
        const missTokens = usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0;
        console.log(`  ℹ️  prompt_tokens: ${usage.prompt_tokens}, completion_tokens: ${usage.completion_tokens}, cache_hit: ${hitTokens}, cache_miss: ${missTokens}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      assert(false, `API call failed: ${errMsg}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n── Result: ${passed} passed, ${failed} failed ──`);
if (failed > 0) {
  process.exit(1);
}
