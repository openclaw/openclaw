#!/usr/bin/env npx tsx
/**
 * Manual test script for Cursor Agent API.
 *
 * Usage:
 *   # Set your API key
 *   export CURSOR_API_KEY="your-api-key"
 *
 *   # List agents
 *   npx tsx scripts/test-api.ts list
 *
 *   # Launch an agent
 *   npx tsx scripts/test-api.ts launch "Fix the bug" https://github.com/user/repo main
 *
 *   # Get agent details
 *   npx tsx scripts/test-api.ts details bc_123456
 */

import { launchAgentTask, listAgents, getAgentDetails } from "../src/api.js";
import type { CursorAgentAccountConfig } from "../src/types.js";

const API_KEY = process.env.CURSOR_API_KEY;

if (!API_KEY) {
  console.error("Error: CURSOR_API_KEY environment variable is required");
  console.error("Get your API key from: https://cursor.com/dashboard?tab=background-agents");
  process.exit(1);
}

const account: CursorAgentAccountConfig = {
  apiKey: API_KEY,
  enabled: true,
};

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "list": {
      console.log("Listing agents...\n");
      try {
        const agents = await listAgents(account);
        if (agents.length === 0) {
          console.log("No agents found.");
        } else {
          console.log(`Found ${agents.length} agent(s):\n`);
          for (const agent of agents) {
            console.log(`  ID: ${agent.id}`);
            console.log(`  Status: ${agent.status}`);
            console.log(`  Created: ${agent.createdAt}`);
            console.log("");
          }
        }
      } catch (error) {
        console.error("Error listing agents:", error);
      }
      break;
    }

    case "launch": {
      const [instructions, repository, branch = "main"] = args;

      if (!instructions || !repository) {
        console.error("Usage: test-api.ts launch <instructions> <repository> [branch]");
        console.error(
          "Example: test-api.ts launch 'Fix the bug' https://github.com/user/repo main",
        );
        process.exit(1);
      }

      console.log("Launching agent...");
      console.log(`  Repository: ${repository}`);
      console.log(`  Branch: ${branch}`);
      console.log(`  Instructions: ${instructions}\n`);

      try {
        const result = await launchAgentTask(account, {
          instructions,
          repository,
          branch,
        });

        console.log("Agent launched successfully!\n");
        console.log(`  ID: ${result.id}`);
        console.log(`  Status: ${result.status}`);
        if (result.url) {
          console.log(`  URL: ${result.url}`);
        }
      } catch (error) {
        console.error("Error launching agent:", error);
      }
      break;
    }

    case "details": {
      const [agentId] = args;

      if (!agentId) {
        console.error("Usage: test-api.ts details <agent-id>");
        process.exit(1);
      }

      console.log(`Getting details for agent ${agentId}...\n`);

      try {
        const details = await getAgentDetails(account, agentId);

        console.log(`  ID: ${details.id}`);
        console.log(`  Status: ${details.status}`);
        if (details.summary) {
          console.log(`  Summary: ${details.summary}`);
        }
        if (details.target?.branchName) {
          console.log(`  Branch: ${details.target.branchName}`);
        }
        if (details.target?.prUrl) {
          console.log(`  PR: ${details.target.prUrl}`);
        }
      } catch (error) {
        console.error("Error getting agent details:", error);
      }
      break;
    }

    case "webhook-test": {
      // Test webhook signature verification
      const { createHmac } = await import("node:crypto");
      const { verifyWebhookSignature } = await import("../src/api.js");

      const secret = "test-secret-12345";
      const payload = '{"event":"statusChange","id":"bc_test"}';
      const signature = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

      console.log("Testing webhook signature verification...\n");
      console.log(`  Payload: ${payload}`);
      console.log(`  Secret: ${secret}`);
      console.log(`  Signature: ${signature}`);

      const isValid = verifyWebhookSignature(payload, signature, secret);
      console.log(`\n  Verification: ${isValid ? "✅ PASSED" : "❌ FAILED"}`);

      // Test invalid signature
      const invalidResult = verifyWebhookSignature(payload, "sha256=invalid", secret);
      console.log(`  Invalid signature test: ${!invalidResult ? "✅ PASSED" : "❌ FAILED"}`);
      break;
    }

    default: {
      console.log("Cursor Agent API Test Script\n");
      console.log("Commands:");
      console.log("  list                              List all agents");
      console.log("  launch <instructions> <repo> [branch]  Launch a new agent");
      console.log("  details <agent-id>                Get agent details");
      console.log("  webhook-test                      Test webhook signature verification");
      console.log("\nEnvironment:");
      console.log("  CURSOR_API_KEY                    Your Cursor API key (required)");
      console.log("\nExamples:");
      console.log('  npx tsx scripts/test-api.ts launch "Add README" https://github.com/user/repo');
      console.log("  npx tsx scripts/test-api.ts list");
      console.log("  npx tsx scripts/test-api.ts details bc_abc123");
    }
  }
}

main().catch(console.error);
