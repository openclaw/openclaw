#!/usr/bin/env npx tsx
/**
 * Test all LLM providers and failover chain.
 *
 * Usage: npx tsx src/test-providers.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

import { KeyManager } from "./content/key-manager.js";
import { parseModelSpec, generateText, generateTextWithFallback } from "./content/llm.js";

const TEST_MESSAGE = {
  system: "You are a helpful assistant. Respond in exactly one short sentence.",
  prompt: "What is 2 + 2?",
};

const PROVIDERS = [
  { name: "Ollama (local)", model: "ollama/gemma4", envKey: "OLLAMA_API_KEY", optional: true },
  { name: "Google AI Studio", model: "google/gemini-2.5-flash", envKey: "GOOGLE_AI_API_KEY" },
  { name: "Groq", model: "groq/llama-3.3-70b-versatile", envKey: "GROQ_API_KEY" },
  {
    name: "OpenRouter",
    model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    envKey: "OPENROUTER_API_KEY",
  },
  { name: "Cerebras", model: "cerebras/llama3.1-8b", envKey: "CEREBRAS_API_KEY" },
];

async function testProvider(name: string, model: string, envKey: string): Promise<boolean> {
  const key = process.env[envKey];
  if (!key) {
    console.log(`  ⏭ ${name}: SKIPPED (${envKey} not set)`);
    return false;
  }

  const keyPreview = `${key.slice(0, 8)}...${key.slice(-4)}`;
  process.stdout.write(`  ⏳ ${name} (${model})... `);

  const start = Date.now();
  try {
    const config = parseModelSpec(model);
    const result = await generateText(config, TEST_MESSAGE);
    const elapsed = Date.now() - start;
    console.log(`✅ ${elapsed}ms — "${result.trim().slice(0, 60)}"`);
    return true;
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = (err as Error).message.slice(0, 100);
    console.log(`❌ ${elapsed}ms — ${msg}`);
    return false;
  }
}

async function testFailover(): Promise<void> {
  console.log("\n🔄 Testing failover chain...");
  const models = PROVIDERS.map((p) => p.model).filter(
    (m) => process.env[PROVIDERS.find((p) => p.model === m)!.envKey],
  );

  if (models.length < 2) {
    console.log("  ⏭ Need at least 2 working providers to test failover");
    return;
  }

  // Test with a bad model first to trigger failover
  const failoverChain = ["google/nonexistent-model-xyz", ...models];
  process.stdout.write(`  ⏳ Chain: ${failoverChain.join(" → ")}... `);

  const start = Date.now();
  try {
    const result = await generateTextWithFallback(failoverChain, TEST_MESSAGE);
    const elapsed = Date.now() - start;
    console.log(`✅ ${elapsed}ms — Failover worked! "${result.trim().slice(0, 60)}"`);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`❌ ${elapsed}ms — ${(err as Error).message.slice(0, 100)}`);
  }
}

async function testKeyManager(): Promise<void> {
  console.log("\n🔑 Testing Key Manager...");

  const km = new KeyManager({});
  await km.initialize();

  for (const provider of ["ollama", "google", "groq", "openrouter", "cerebras"]) {
    const count = km.countAvailable(provider);
    const key = km.getActiveKey(provider);
    const keyPreview = key ? `${key.slice(0, 8)}...${key.slice(-4)}` : "none";
    console.log(
      `  ${count > 0 ? "✅" : "⏭"} ${provider}: ${count} key(s) available (active: ${keyPreview})`,
    );
  }

  // Test rotation
  console.log("\n  Testing key rotation (Google)...");
  const googleCount = km.countAvailable("google");
  if (googleCount > 0) {
    const key1 = km.getActiveKey("google");
    const key2 = km.getActiveKey("google");
    console.log(`  Key 1: ${key1?.slice(0, 8)}...`);
    console.log(`  Key 2: ${key2?.slice(0, 8)}...`);
    console.log(`  ${key1 === key2 ? "Same key (only 1 available)" : "Rotated! ✅"}`);

    // Test exhaustion
    if (key1) {
      km.markExhausted("google", key1);
      const remaining = km.countAvailable("google");
      console.log(`  After marking exhausted: ${remaining} key(s) remaining`);
    }
  } else {
    console.log("  ⏭ No Google keys to test rotation");
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Content Pipeline — Provider Test Suite      ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Test 1: Individual providers
  console.log("📡 Testing individual providers...\n");
  const results: boolean[] = [];
  for (const p of PROVIDERS) {
    const ok = await testProvider(p.name, p.model, p.envKey);
    results.push(ok);
  }

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n  Summary: ${passed}/${total} providers working`);

  // Test 2: Failover
  await testFailover();

  // Test 3: Key Manager
  await testKeyManager();

  // Final summary
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║  Results: ${passed}/${total} providers ✅                    ║`);
  console.log(`║  Failover chain: ${passed >= 2 ? "READY ✅" : "NEEDS 2+ PROVIDERS"}         ║`);
  console.log("╚══════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
});
