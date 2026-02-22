import { getAgentTeams } from "../src/lib/agent-registry";

console.log("Running TDD: getAgentTeams...");

try {
  const teams = getAgentTeams();
  const soloFounder = teams.find((t) => t.id === "solo-founder-team");

  if (!soloFounder) {
    throw new Error("Could not find 'solo-founder-team'");
  }

  console.log("PASSED");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("FAILED:", message);
  process.exit(1);
}
