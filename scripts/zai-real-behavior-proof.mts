#!/usr/bin/env node
// Standalone real-behavior proof helper for PR #97786.
// Runs a single Z.ai GLM-5.2 chat completion using the local provider code,
// prints the redacted request payload, and reports whether reasoning content
// was returned.
//
// Usage:
//   ZAI_API_KEY=<key> npx tsx scripts/zai-real-behavior-proof.mts

import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  streamOpenAICompletions,
  type OpenAICompletionsOptions,
} from "../src/llm/providers/openai-completions.js";

const apiKey = process.env.ZAI_API_KEY?.trim() ?? process.env.Z_AI_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.error("Error: ZAI_API_KEY or Z_AI_API_KEY is required.");
  process.exit(1);
}

const model: Model<"openai-completions"> = {
  id: "glm-5.2",
  name: "GLM 5.2",
  api: "openai-completions",
  provider: "zai",
  baseUrl: "https://api.z.ai/api/paas/v4",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 4096,
};

const context: Context = {
  id: "zai-real-behavior-proof",
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Briefly explain what 2+2 equals." }],
};

const options: OpenAICompletionsOptions = {
  apiKey,
  reasoningEffort: "high",
  maxTokens: 256,
  temperature: 0,
  timeoutMs: 60_000,
  onPayload(payload) {
    const redacted = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    if (typeof redacted.api_key === "string") redacted.api_key = "***REDACTED***";
    console.log("--- Outgoing payload (redacted) ---");
    console.log(JSON.stringify(redacted, null, 2));
    console.log("-----------------------------------");
  },
};

async function main() {
  const stream = streamOpenAICompletions(model, context, options);
  const result = await stream.result();

  console.log("\n--- Result summary ---");
  console.log("stopReason:", result.stopReason);
  console.log("content blocks:", JSON.stringify(result.content.map((b) => b.type)));

  const thinkingBlocks = result.content.filter((b) => b.type === "thinking");
  if (thinkingBlocks.length > 0) {
    console.log("\n✓ reasoning_content / thinking blocks were returned:");
    for (const block of thinkingBlocks) {
      console.log("-", block.type, ":", (block as { thinking?: string }).thinking?.slice(0, 200));
    }
  } else {
    console.log("\n✗ No thinking blocks were returned in the response.");
  }

  if (result.stopReason === "error") {
    console.error("\nRequest ended with an error.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
