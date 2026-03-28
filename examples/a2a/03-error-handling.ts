/**
 * Example: A2A Error Handling Patterns
 *
 * Demonstrates proper error handling for A2A calls.
 */

import { createAgentCallTool } from "../src/agents/tools/agent-call-tool.js";
import { A2AError, A2AErrorCode } from "../src/infra/a2a-result-cache.js";

async function callWithRetry(agent: string, skill: string, input: unknown, maxRetries = 3) {
  const agentCall = createAgentCallTool({
    agentSessionKey: "agent:main:main",
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await agentCall.execute(`call-${attempt}`, {
        agent,
        skill,
        input,
        timeoutSeconds: 60,
      });

      const parsed = JSON.parse(result);

      if (parsed.status === "error") {
        // Handle typed A2A errors
        if (parsed.error?.includes("Self-call not allowed")) {
          console.log("Self-call blocked - cannot call yourself");
          return null;
        }

        if (parsed.error?.includes("not in allowlist")) {
          console.log(`Agent '${agent}' is not in the A2A allowlist`);
          return null;
        }

        // Retry on transient errors
        if (parsed.error?.includes("timeout") || parsed.error?.includes("cache miss")) {
          console.log(`Attempt ${attempt} failed, retrying...`);
          continue;
        }

        // Non-retryable error
        return parsed;
      }

      return parsed;
    } catch (err) {
      console.log(
        `Attempt ${attempt} threw error:`,
        err instanceof Error ? err.message : String(err),
      );

      // Check if it's a typed A2A error
      if (err instanceof A2AError) {
        switch (err.code) {
          case A2AErrorCode.NOT_ENABLED:
            console.log("A2A is not enabled in configuration");
            return null;

          case A2AErrorCode.AGENT_NOT_ALLOWED:
            console.log(`Agent '${agent}' is not allowed for A2A calls`);
            return null;

          case A2AErrorCode.SELF_CALL_BLOCKED:
            console.log("Self-call blocked - prevents infinite loops");
            return null;

          case A2AErrorCode.CACHE_TIMEOUT:
          case A2AErrorCode.CACHE_MISS:
            // Retry on cache-related errors
            console.log(`Cache issue on attempt ${attempt}, retrying...`);
            continue;

          default:
            console.log(`A2A error: ${err.code} - ${err.message}`);
            return null;
        }
      }
    }
  }

  console.log(`All ${maxRetries} attempts failed`);
  return null;
}

async function main() {
  // Example 1: Successful call
  console.log("--- Successful call ---");
  const success = await callWithRetry("metis", "research", {
    query: "Test query",
  });
  console.log("Result:", success);

  // Example 2: Self-call (blocked)
  console.log("\n--- Self-call (blocked) ---");
  const selfCall = await callWithRetry("main", "consult", {
    question: "Test",
  });
  console.log("Result:", selfCall);

  // Example 3: Non-existent skill
  console.log("\n--- Non-existent skill ---");
  const noSkill = await callWithRetry("metis", "nonexistent", {});
  console.log("Result:", noSkill);
}

main().catch(console.error);
