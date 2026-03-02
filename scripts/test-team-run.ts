#!/usr/bin/env bun
/**
 * Simulates a team run lifecycle to test the teams coordination layer.
 * Creates a team, adds members, creates tasks, sends messages, then completes.
 *
 * Usage: bun scripts/test-team-run.ts [--cleanup]
 */

import { sendTeamMessage, listTeamMessages } from "../src/teams/team-message-store.js";
import {
  createTeamRun,
  listTeamRuns,
  addTeamMember,
  updateMemberState,
} from "../src/teams/team-store.js";
import { saveTeamStore } from "../src/teams/team-store.js";
import { createTeamTask, listTeamTasks, updateTeamTask } from "../src/teams/team-task-store.js";

const cleanup = process.argv.includes("--cleanup");

if (cleanup) {
  console.log("Cleaning up all team runs...");
  saveTeamStore({ runs: {}, tasks: {}, messages: {} });
  console.log("Done. Store is empty.");
  process.exit(0);
}

console.log("\n=== Creating Team Run ===");
const team = createTeamRun({
  name: "auth-refactor",
  leader: "neo",
  leaderSession: "agent:neo:main",
});
console.log(`Created team: "${team.name}" (${team.id})`);
console.log(`  Leader: ${team.leader}`);
console.log(`  State: ${team.state}`);

console.log("\n=== Adding Members ===");
const m1 = addTeamMember(team.id, {
  agentId: "tank",
  sessionKey: "agent:tank:subagent:test-1",
  role: "coder",
});
console.log(`  Added: tank (${m1?.state})`);

const m2 = addTeamMember(team.id, {
  agentId: "dozer",
  sessionKey: "agent:dozer:subagent:test-2",
  role: "tester",
});
console.log(`  Added: dozer (${m2?.state})`);

const m3 = addTeamMember(team.id, {
  agentId: "mouse",
  sessionKey: "agent:mouse:subagent:test-3",
  role: "researcher",
});
console.log(`  Added: mouse (${m3?.state})`);

console.log("\n=== Creating Tasks ===");
const t1 = createTeamTask({
  teamRunId: team.id,
  subject: "Research auth patterns",
  description: "Survey JWT vs session-based auth approaches",
});
console.log(`  Task 1: ${t1.subject} (${t1.status})`);

const t2 = createTeamTask({
  teamRunId: team.id,
  subject: "Implement JWT middleware",
  description: "Create Express middleware for JWT validation",
});
console.log(`  Task 2: ${t2.subject} (${t2.status})`);

const t3 = createTeamTask({
  teamRunId: team.id,
  subject: "Write integration tests",
  description: "Test auth flow end-to-end",
});
console.log(`  Task 3: ${t3.subject} (${t3.status})`);

// Set up dependency: t3 blocked by t2
updateTeamTask(team.id, t3.id, { blockedBy: [t2.id] });
console.log(`  Task 3 blocked by Task 2`);

// Assign tasks
updateTeamTask(team.id, t1.id, { owner: "mouse" });
updateTeamTask(team.id, t2.id, { owner: "tank" });
updateTeamTask(team.id, t3.id, { owner: "dozer" });
console.log(`  Assigned: mouse→T1, tank→T2, dozer→T3`);

console.log("\n=== Sending Messages ===");
sendTeamMessage({
  teamRunId: team.id,
  from: "neo",
  to: "broadcast",
  content:
    "Team, let's refactor the auth module. Mouse: research first, Tank: implement, Dozer: test.",
});
console.log(`  neo → broadcast: kickoff message`);

sendTeamMessage({
  teamRunId: team.id,
  from: "mouse",
  to: "neo",
  content: "Found 3 good JWT libraries. Recommending jose for ES module support.",
});
console.log(`  mouse → neo: research findings`);

sendTeamMessage({
  teamRunId: team.id,
  from: "neo",
  to: "tank",
  content: "Go with jose. Mouse found it's the best fit.",
});
console.log(`  neo → tank: direction`);

console.log("\n=== Simulating Progress ===");

// Mouse starts researching
updateMemberState(team.id, "mouse", "running");
updateTeamTask(team.id, t1.id, { status: "in_progress" });
console.log(`  mouse: running, Task 1: in_progress`);

// Mouse finishes research
updateTeamTask(team.id, t1.id, { status: "completed" });
updateMemberState(team.id, "mouse", "done");
console.log(`  mouse: done, Task 1: completed`);

// Tank starts implementation
updateMemberState(team.id, "tank", "running");
updateTeamTask(team.id, t2.id, { status: "in_progress" });
console.log(`  tank: running, Task 2: in_progress`);

console.log("\n=== Current State ===");
const runs = listTeamRuns({ state: "active" });
console.log(`Active team runs: ${runs.length}`);
for (const r of runs) {
  console.log(`  "${r.name}" — ${r.members.length} members, state: ${r.state}`);
  for (const m of r.members) {
    console.log(`    ${m.agentId} (${m.role ?? "no role"}): ${m.state}`);
  }
}

const tasks = listTeamTasks(team.id);
console.log(
  `\nTasks (${tasks.filter((t) => t.status === "completed").length}/${tasks.length} done):`,
);
for (const t of tasks) {
  const blocked = t.blockedBy.length > 0 ? ` [blocked by ${t.blockedBy.length}]` : "";
  console.log(`  ${t.subject}: ${t.status} (owner: ${t.owner ?? "unassigned"})${blocked}`);
}

const msgs = listTeamMessages(team.id);
console.log(`\nMessages: ${msgs.length}`);
for (const m of msgs) {
  console.log(`  ${m.from} → ${m.to}: ${m.content.slice(0, 60)}...`);
}

console.log("\n=== Done ===");
console.log(`Team run "${team.name}" is now active with in-progress work.`);
console.log(`Open https://localhost:5174/sessions to see the Teams panel.`);
console.log(`Open https://localhost:5174/visualize to see team overlay on canvas.`);
console.log(`\nTo clean up: bun scripts/test-team-run.ts --cleanup`);
