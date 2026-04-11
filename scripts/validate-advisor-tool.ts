/**
 * Validate advisor tool handling with a real API call.
 *
 * Usage: npx tsx scripts/validate-advisor-tool.ts
 *
 * Reads ANTHROPIC_API_KEY from .env at repo root.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// Load API key from .env
const envPath = resolve(import.meta.dirname ?? ".", "..", ".env");
const envContent = readFileSync(envPath, "utf-8");
const apiKeyMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
if (!apiKeyMatch) {
  console.error("ANTHROPIC_API_KEY not found in .env");
  process.exit(1);
}

const client = new Anthropic({ apiKey: apiKeyMatch[1].trim() });

async function main() {
  console.log("Making streaming API call with advisor tool (beta)...\n");

  const stream = client.beta.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    betas: ["advisor-tool-2026-03-01"],
    tools: [
      // advisor_20260301 is a beta tool type not yet in the typed SDK union.
      // Cast through unknown then a known tool-type literal to satisfy the
      // SDK's discriminated union without importing the internal union type.
      // The runtime payload is correct — only the type check is bypassed.
      {
        type: "advisor_20260301" as unknown as "computer_20250124",
        name: "advisor",
        model: "claude-sonnet-4-6",
      },
    ],
    messages: [
      {
        role: "user",
        content:
          "What are the key differences between TCP and UDP? Think carefully before answering.",
      },
    ],
  });

  const blockTypes: string[] = [];
  const blockContents: Record<string, unknown>[] = [];

  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown>;
      const parts = [`content_block_start: type=${String(block.type)}`];
      if (typeof block.name === "string") {
        parts.push(`name=${block.name}`);
      }
      if (typeof block.tool_use_id === "string") {
        parts.push(`tool_use_id=${block.tool_use_id}`);
      }
      console.log(parts.join(", "));
      blockTypes.push(String(block.type));
      blockContents.push(block);
    }
    if (event.type === "content_block_stop") {
      console.log(`content_block_stop: index=${event.index}`);
    }
    if (event.type === "message_delta") {
      const delta = event.delta as Record<string, unknown>;
      console.log(`message_delta: stop_reason=${String(delta.stop_reason)}`);
    }
  });

  const finalMessage = await stream.finalMessage();

  console.log("\n--- Summary ---");
  console.log(`Total content blocks: ${finalMessage.content.length}`);
  console.log(`Block types seen: ${blockTypes.join(", ")}`);
  console.log(`Stop reason: ${finalMessage.stop_reason}`);

  const hasAdvisorUse = blockContents.some(
    (b) => b.type === "server_tool_use" && b.name === "advisor",
  );
  const hasAdvisorResult = blockTypes.includes("advisor_tool_result");

  console.log(`\nadvisor server_tool_use present: ${hasAdvisorUse}`);
  console.log(`advisor_tool_result present: ${hasAdvisorResult}`);

  if (hasAdvisorUse && hasAdvisorResult) {
    console.log("\n✓ Advisor tool flow confirmed.");
  } else if (!hasAdvisorUse && !hasAdvisorResult) {
    console.log(
      "\n⚠ Model did not invoke advisor. This may be normal — the model decides when to use it.",
    );
  } else {
    console.log("\n⚠ Partial advisor flow — inspect blocks below.");
  }

  // Print raw content blocks
  console.log("\n--- Raw Content Blocks ---");
  for (const block of finalMessage.content) {
    const serialized = JSON.stringify(block, null, 2);
    console.log(serialized.slice(0, 800));
    console.log("---");
  }

  // Print usage
  console.log("\n--- Usage ---");
  console.log(JSON.stringify(finalMessage.usage, null, 2));
}

main().catch(console.error);
