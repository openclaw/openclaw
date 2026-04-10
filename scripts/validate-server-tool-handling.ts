/**
 * Validate server-side tool handling by making a real API call with web_search.
 *
 * Usage: npx tsx scripts/validate-server-tool-handling.ts
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
  console.log("Making streaming API call with web_search tool...\n");

  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    tools: [
      {
        type: "web_search_20260209" as unknown as "computer_20250124",
        name: "web_search",
        max_uses: 1,
      },
    ],
    messages: [
      {
        role: "user",
        content: "What is the current weather in San Francisco? Use web search.",
      },
    ],
  });

  const blockTypes: string[] = [];

  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown>;
      const blockType = String(block.type);
      const blockName = typeof block.name === "string" ? block.name : "n/a";
      console.log(`content_block_start: type=${blockType}, name=${blockName}`);
      blockTypes.push(blockType);
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

  const hasServerToolUse = blockTypes.includes("server_tool_use");
  const hasToolResult = blockTypes.some((t) => t.endsWith("_tool_result"));

  console.log(`\nserver_tool_use block present: ${hasServerToolUse}`);
  console.log(`*_tool_result block present: ${hasToolResult}`);

  if (hasServerToolUse && hasToolResult) {
    console.log("\n✓ Server-side tool blocks confirmed in stream.");
  } else {
    console.log("\n✗ Expected server-side tool blocks not found.");
  }

  // Print raw content blocks for inspection
  console.log("\n--- Raw Content Blocks ---");
  for (const block of finalMessage.content) {
    console.log(JSON.stringify(block, null, 2).slice(0, 500));
    console.log("---");
  }
}

main().catch(console.error);
