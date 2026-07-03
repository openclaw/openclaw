import { listControlledSubagentRuns } from "../src/agents/subagent-control.js";
/**
 * Real behavior proof for PR #99410: verify OR-match filter behavior.
 *
 * Simulates the two-key scenario described in the root cause:
 * - controllerSessionKey = "agent:main:main" (from agentSessionKey)
 * - requesterSessionKey = "agent:main:telegram:direct:abc123" (from runSessionKey)
 *
 * Uses actual exports from the built modules to prove the fix works.
 */
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../src/agents/subagent-registry.js";

function main() {
  resetSubagentRegistryForTests({ persist: false });

  const now = Date.now();

  // Scenario 1: controllerSessionKey matches (original path)
  addSubagentRunForTests({
    runId: "run-scenario-1",
    childSessionKey: "agent:main:subagent:test-proof-75593",
    controllerSessionKey: "agent:main:main",
    requesterSessionKey: "agent:main:telegram:direct:abc123",
    requesterDisplayKey: "main",
    task: "test subagent with split keys",
    cleanup: "keep",
    createdAt: now - 30_000,
    startedAt: now - 30_000,
  });

  const results1 = listControlledSubagentRuns("agent:main:main");
  console.log("=== Scenario 1: controllerKey matches ===");
  console.log(`controllerKey: agent:main:main, requesterKey: agent:main:telegram:direct:abc123`);
  console.log(`Search: agent:main:main → ${results1.length} result(s)`);
  console.log(results1.length > 0 ? "PASS" : "FAIL");
  console.log("");

  // Scenario 2: requesterSessionKey matches via OR fallback (NEW behavior)
  resetSubagentRegistryForTests({ persist: false });
  addSubagentRunForTests({
    runId: "run-scenario-2",
    childSessionKey: "agent:main:subagent:test-proof-75593-b",
    controllerSessionKey: "agent:main:telegram:direct:abc123",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "subagent spawned via telegram channel",
    cleanup: "keep",
    createdAt: now - 10_000,
    startedAt: now - 10_000,
  });

  const results2 = listControlledSubagentRuns("agent:main:main");
  console.log("=== Scenario 2: requesterKey matches (OR fallback) ===");
  console.log(`controllerKey: agent:main:telegram:direct:abc123, requesterKey: agent:main:main`);
  console.log(`Search: agent:main:main → ${results2.length} result(s)`);
  console.log(results2.length > 0 ? "PASS" : "FAIL");
  console.log("");

  // Scenario 3: neither matches (scope isolation)
  resetSubagentRegistryForTests({ persist: false });
  addSubagentRunForTests({
    runId: "run-scenario-3",
    childSessionKey: "agent:main:subagent:unrelated",
    controllerSessionKey: "agent:other:discord:direct:xyz",
    requesterSessionKey: "agent:other:discord:direct:xyz",
    requesterDisplayKey: "other",
    task: "unrelated subagent",
    cleanup: "keep",
    createdAt: now,
    startedAt: now,
  });

  const results3 = listControlledSubagentRuns("agent:main:main");
  console.log("=== Scenario 3: neither key matches (scope isolation) ===");
  console.log(`controllerKey: agent:other:..., requesterKey: agent:other:...`);
  console.log(`Search: agent:main:main → ${results3.length} result(s)`);
  console.log(results3.length === 0 ? "PASS" : "FAIL");
  console.log("");

  const allPass = results1.length > 0 && results2.length > 0 && results3.length === 0;
  console.log(allPass ? "ALL SCENARIOS PASS" : "SOME SCENARIOS FAILED");
  process.exit(allPass ? 0 : 1);
}

main();
