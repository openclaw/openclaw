/**
 * Example: Basic A2A agent_call
 *
 * Demonstrates calling another agent's skill with structured input/output.
 */

import { createAgentCallTool } from "../src/agents/tools/agent-call-tool.js";

async function main() {
  // Create the agent_call tool with your session context
  const agentCall = createAgentCallTool({
    agentSessionKey: "agent:main:main",
  });

  // Call the research skill on Métis
  const result = await agentCall.execute("call-1", {
    agent: "metis",
    skill: "research",
    input: {
      query: "What are the latest advances in quantum computing?",
      depth: "deep",
    },
    mode: "execute",
    timeoutSeconds: 300,
  });

  console.log("Result:", JSON.parse(result));
}

main().catch(console.error);
