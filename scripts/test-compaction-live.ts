#!/usr/bin/env bun
/**
 * Live test for compaction summarization with a real LLM.
 * Verifies that summarizeInStages produces a meaningful summary
 * and that the compaction-safeguard extension returns a valid
 * compaction result (not cancel) when model + API key are available.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL="https://code.mmkg.cloud" \
 *   ANTHROPIC_AUTH_TOKEN="sk-..." \
 *   bun scripts/test-compaction-live.ts
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { summarizeInStages } from "../src/agents/compaction.js";
import { resolveModel } from "../src/agents/pi-embedded-runner/model.js";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5-20251001";

async function main() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error("❌ Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    process.exit(1);
  }
  if (baseUrl) {
    // pi-ai reads ANTHROPIC_BASE_URL for custom endpoints
    process.env.ANTHROPIC_BASE_URL = baseUrl;
  }

  console.log(`🔧 Provider: ${PROVIDER}, Model: ${MODEL_ID}`);
  console.log(`🔧 Base URL: ${baseUrl ?? "(default)"}`);

  // Resolve model
  const { model, error, authStorage } = resolveModel(PROVIDER, MODEL_ID);
  if (!model) {
    console.error(`❌ resolveModel failed: ${error}`);
    process.exit(1);
  }

  // Override baseUrl if custom endpoint is provided
  if (baseUrl) {
    (model as unknown as Record<string, unknown>).baseUrl = baseUrl;
  }

  // Set runtime API key
  authStorage.setRuntimeApiKey(PROVIDER, apiKey);

  // Build sample conversation messages
  const messages: AgentMessage[] = [
    {
      role: "user",
      content:
        "I need help setting up a Docker container for my Node.js app. It should use Node 22 and expose port 3000.",
      timestamp: Date.now() - 60000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'I\'ll help you create a Dockerfile for your Node.js app. Here\'s what I recommend:\n\n```dockerfile\nFROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n```\n\nThis uses the slim image for smaller size, copies package files first for better caching, and runs npm ci for reproducible installs.',
        },
      ],
      timestamp: Date.now() - 50000,
    } as AgentMessage,
    {
      role: "user",
      content: "Can you also add a docker-compose.yml with a PostgreSQL database?",
      timestamp: Date.now() - 40000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Here's a docker-compose.yml:\n\n```yaml\nversion: '3.8'\nservices:\n  app:\n    build: .\n    ports:\n      - '3000:3000'\n    environment:\n      - DATABASE_URL=postgresql://user:pass@db:5432/myapp\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: user\n      POSTGRES_PASSWORD: pass\n      POSTGRES_DB: myapp\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n    healthcheck:\n      test: ['CMD-SHELL', 'pg_isready -U user']\n      interval: 5s\n      timeout: 5s\n      retries: 5\nvolumes:\n  pgdata:\n```\n\nKey decisions:\n- Uses health checks so the app waits for DB\n- Named volume for data persistence\n- PostgreSQL 16 for latest features",
        },
      ],
      timestamp: Date.now() - 30000,
    } as AgentMessage,
  ];

  const contextWindow = model.contextWindow ?? 200_000;
  const maxChunkTokens = Math.floor(contextWindow * 0.4);
  const reserveTokens = 16384;
  const abortController = new AbortController();

  console.log("\n📝 Summarizing conversation with real LLM...\n");

  try {
    const summary = await summarizeInStages({
      messages,
      model,
      apiKey,
      signal: abortController.signal,
      reserveTokens,
      maxChunkTokens,
      contextWindow,
    });

    console.log("✅ Summary generated successfully!\n");
    console.log("─".repeat(60));
    console.log(summary);
    console.log("─".repeat(60));

    // Validate summary quality
    const isUseless =
      summary.includes("Summary unavailable") || summary.includes("No prior history");
    if (isUseless) {
      console.error("\n❌ Summary is a fallback — not a real summary!");
      process.exit(1);
    }

    if (summary.length < 50) {
      console.error(`\n❌ Summary too short (${summary.length} chars)`);
      process.exit(1);
    }

    console.log(`\n✅ Summary looks valid (${summary.length} chars)`);
  } catch (err) {
    console.error("\n❌ Summarization failed:", err);
    process.exit(1);
  }

  // Now test the extension handler directly
  console.log("\n📝 Testing compaction-safeguard extension handler...\n");

  try {
    const mod = await import("../src/agents/pi-extensions/compaction-safeguard.js");
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    const api = {
      on(_event: string, h: (event: unknown, ctx: unknown) => Promise<unknown>) {
        handler = h;
      },
    };
    mod.default(api as never);

    if (!handler) {
      console.error("❌ Extension did not register handler");
      process.exit(1);
    }

    const preparation = {
      firstKeptEntryId: "test-entry-1",
      tokensBefore: 50_000,
      messagesToSummarize: messages,
      turnPrefixMessages: [] as AgentMessage[],
      isSplitTurn: false,
      previousSummary: undefined,
      fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    };

    const event = {
      type: "session_before_compact" as const,
      preparation,
      branchEntries: [],
      customInstructions: undefined,
      signal: new AbortController().signal,
    };

    const ctx = {
      model,
      modelRegistry: { getApiKey: async () => apiKey },
      sessionManager: {},
    };

    const result = (await handler(event, ctx)) as {
      cancel?: boolean;
      compaction?: { summary: string; firstKeptEntryId: string };
    };

    if (result.cancel) {
      console.error("❌ Extension returned cancel — should have succeeded!");
      process.exit(1);
    }

    if (!result.compaction) {
      console.error("❌ Extension returned no compaction result");
      process.exit(1);
    }

    console.log("✅ Extension returned valid compaction result!");
    console.log(`   Summary length: ${result.compaction.summary.length} chars`);
    console.log(`   firstKeptEntryId: ${result.compaction.firstKeptEntryId}`);

    const isUseless =
      result.compaction.summary.includes("Summary unavailable") ||
      result.compaction.summary.length < 50;
    if (isUseless) {
      console.error("❌ Extension summary is a fallback!");
      process.exit(1);
    }

    console.log("\n✅ All live tests passed!");
  } catch (err) {
    console.error("\n❌ Extension handler test failed:", err);
    process.exit(1);
  }
}

main();
