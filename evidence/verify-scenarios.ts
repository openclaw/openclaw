import { listControlledSubagentRuns } from "../src/agents/subagent-control.js";
/**
 * Real behavior proof for PR #99410 — standalone scenario runner.
 * Each invocation tests one scenario in isolation to avoid cross-scenario state pollution.
 */
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../src/agents/subagent-registry.js";

const scenario = process.argv[2] || "1";
const now = Date.now();

resetSubagentRegistryForTests({ persist: false });

if (scenario === "1") {
  addSubagentRunForTests({
    runId: "run-s1",
    childSessionKey: "agent:main:subagent:proof-s1",
    controllerSessionKey: "agent:main:main",
    requesterSessionKey: "agent:main:telegram:direct:abc123",
    requesterDisplayKey: "main",
    task: "controller key matches",
    cleanup: "keep",
    createdAt: now,
    startedAt: now,
  });
  const r = listControlledSubagentRuns("agent:main:main");
  console.log(
    `[S1] controller=agent:main:main requester=telegram → ${r.length} result(s) ${r.length > 0 ? "PASS" : "FAIL"}`,
  );
} else if (scenario === "2") {
  addSubagentRunForTests({
    runId: "run-s2",
    childSessionKey: "agent:main:subagent:proof-s2",
    controllerSessionKey: "agent:main:telegram:direct:abc123",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "requester key matches",
    cleanup: "keep",
    createdAt: now,
    startedAt: now,
  });
  const r = listControlledSubagentRuns("agent:main:main");
  console.log(
    `[S2] controller=telegram requester=agent:main:main → ${r.length} result(s) ${r.length > 0 ? "PASS" : "FAIL"}`,
  );
} else if (scenario === "3") {
  addSubagentRunForTests({
    runId: "run-s3",
    childSessionKey: "agent:main:subagent:unrelated",
    controllerSessionKey: "agent:other:discord:direct:xyz",
    requesterSessionKey: "agent:other:discord:direct:xyz",
    requesterDisplayKey: "other",
    task: "unrelated",
    cleanup: "keep",
    createdAt: now,
    startedAt: now,
  });
  const r = listControlledSubagentRuns("agent:main:main");
  console.log(
    `[S3] controller=other requester=other → ${r.length} result(s) ${r.length === 0 ? "PASS" : "FAIL"}`,
  );
}
