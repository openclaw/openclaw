/**
 * Example: Multi-agent Debate Call
 *
 * Demonstrates orchestrating a debate between multiple agents.
 */

import { createDebateCallTool } from "../src/agents/tools/debate-call-tool.js";

async function main() {
  // Create the debate_call tool
  const debateCall = createDebateCallTool({
    agentSessionKey: "agent:main:main",
  });

  // Orchestrate a debate on system architecture
  const result = await debateCall.execute("debate-1", {
    topic: "Should we adopt a microservices architecture?",
    proposer: {
      agent: "skyline",
      skill: "propose",
    },
    critics: [
      {
        agent: "metis",
        skill: "critique",
        perspective: "maintenance burden",
      },
      {
        agent: "hephaestus",
        skill: "critique",
        perspective: "security implications",
      },
    ],
    resolver: {
      agent: "main",
      skill: "synthesize",
    },
    input: {
      context: `
        Current architecture: Monolithic Node.js application
        Team size: 12 engineers
        Deployment frequency: Weekly
        Pain points: Slow builds, difficult to scale individual components
      `,
    },
    maxRounds: 2,
    timeoutSeconds: 600,
  });

  console.log("Debate Result:", JSON.parse(result, null, 2));
}

main().catch(console.error);
