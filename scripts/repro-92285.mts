/**
 * Reproduction script for issue #92285.
 *
 * Demonstrates that a managed TaskFlow with all terminal child tasks
 * is now reconciled to "lost" by task-flow maintenance.
 */
import { createManagedTaskFlow, getTaskFlowById, listTaskFlowRecords, resetTaskFlowRegistryForTests, requestFlowCancel } from "../src/tasks/task-flow-registry.js";
import { createRunningTaskRun as createRunningTaskRunOrNull } from "../src/tasks/task-executor.js";
import { previewTaskFlowRegistryMaintenance, runTaskFlowRegistryMaintenance } from "../src/tasks/task-flow-registry.maintenance.js";
import { resetTaskRegistryDeliveryRuntimeForTests, resetTaskRegistryForTests } from "../src/tasks/task-registry.js";

const BASE_TIME = 500_000;

function setup() {
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests();
}

function log(label: string, obj: unknown) {
  console.log(`  ${label}: ${JSON.stringify(obj)}`);
}

// ── Test 1: Running managed flow with terminal child → reconciled to lost ──
console.log("═══ Test 1: Orphaned managed flow reconciliation ═══");
setup();

const flow1 = createManagedTaskFlow({
  ownerKey: "agent:main:main",
  controllerId: "repro-92285",
  goal: "Subagent orchestration flow",
  status: "running",
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME,
});
log("Flow created", { id: flow1.flowId, status: flow1.status, syncMode: flow1.syncMode });

// Create a child task (mimics the subagent task that was spawned)
const child1 = createRunningTaskRunOrNull({
  runtime: "subagent",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  parentFlowId: flow1.flowId,
  childSessionKey: "agent:main:subagent:lost-session",
  runId: "run-child-1",
  task: "Full-agent child task",
  startedAt: BASE_TIME + 10,
  lastEventAt: BASE_TIME + 10,
});
if (child1) log("Child task created", { id: child1.taskId, status: child1.status, flowId: child1.parentFlowId });

// Simulate maintenance running BEFORE child is terminal → should NOT reconcile
const previewBefore = previewTaskFlowRegistryMaintenance();
log("Preview (child alive)", previewBefore);

// Now mark the child task as terminal (simulating it becoming "lost")
// We directly update the task's status to test the flow reconciliation
const { markTaskLostById } = await import("../src/tasks/task-registry.js");
const childMarked = markTaskLostById({
  taskId: child1!.taskId,
  endedAt: BASE_TIME + 60_000,
  lastEventAt: BASE_TIME + 60_000,
  error: "backing session missing",
});
log("Child marked lost", { id: childMarked?.taskId, status: childMarked?.status });

// Run maintenance — should reconcile the orphaned flow to "lost"
const summary = await runTaskFlowRegistryMaintenance();
log("Maintenance summary", summary);

const storedFlow1 = getTaskFlowById(flow1.flowId);
log("Flow after maintenance", { id: storedFlow1?.flowId, status: storedFlow1?.status });

// ── Test 2: Running flow with NO tasks → NOT reconciled ──
console.log("\n═══ Test 2: Running flow with no tasks is not touched ═══");
setup();

const flow2 = createManagedTaskFlow({
  ownerKey: "agent:main:main",
  controllerId: "repro-92285",
  goal: "Empty managed flow",
  status: "running",
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME,
});
log("Flow created (no tasks)", { id: flow2.flowId, status: flow2.status });

const summary2 = await runTaskFlowRegistryMaintenance();
log("Maintenance summary", summary2);

const storedFlow2 = getTaskFlowById(flow2.flowId);
log("Flow after maintenance", { id: storedFlow2?.flowId, status: storedFlow2?.status });

// ── Test 3: Queued managed flow with terminal child → reconciled ──
console.log("\n═══ Test 3: Queued managed flow with terminal child ═══");
setup();

const flow3 = createManagedTaskFlow({
  ownerKey: "agent:main:main",
  controllerId: "repro-92285",
  goal: "Queued flow with dead child",
  status: "queued",
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME,
});
log("Flow created (queued)", { id: flow3.flowId, status: flow3.status });

const child3 = createRunningTaskRunOrNull({
  runtime: "subagent",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  parentFlowId: flow3.flowId,
  childSessionKey: "agent:main:subagent:dead",
  runId: "run-child-3",
  task: "Dead child task",
  startedAt: BASE_TIME + 10,
  lastEventAt: BASE_TIME + 10,
});
if (child3) log("Child task created", { id: child3.taskId, status: child3.status });

// Mark child terminal
markTaskLostById({
  taskId: child3!.taskId,
  endedAt: BASE_TIME + 60_000,
  lastEventAt: BASE_TIME + 60_000,
  error: "backing session missing",
});

const summary3 = await runTaskFlowRegistryMaintenance();
log("Maintenance summary", summary3);

const storedFlow3 = getTaskFlowById(flow3.flowId);
log("Flow after maintenance", { id: storedFlow3?.flowId, status: storedFlow3?.status });

// ── Test 4: Cancel-requested managed flow still handled by existing logic ──
console.log("\n═══ Test 4: Cancel-requested flow still finalizes as cancelled ═══");
setup();

const flow4 = createManagedTaskFlow({
  ownerKey: "agent:main:main",
  controllerId: "repro-92285",
  goal: "Cancel requested flow",
  status: "running",
  cancelRequestedAt: BASE_TIME + 10,
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME + 10,
});
log("Flow created (cancel requested)", { id: flow4.flowId, status: flow4.status });

const summary4 = await runTaskFlowRegistryMaintenance();
log("Maintenance summary", summary4);

const storedFlow4 = getTaskFlowById(flow4.flowId);
log("Flow after maintenance", { id: storedFlow4?.flowId, status: storedFlow4?.status });

// ── Summary ──
console.log("\n═══ Results ═══");
const passed1 = storedFlow1?.status === "lost";
const passed2 = storedFlow2?.status === "running";
const passed3 = storedFlow3?.status === "lost";
const passed4 = storedFlow4?.status === "cancelled";
console.log(`Test 1 (orphaned managed flow → lost): ${passed1 ? "PASS" : "FAIL"}`);
console.log(`Test 2 (empty managed flow untouched): ${passed2 ? "PASS" : "FAIL"}`);
console.log(`Test 3 (queued flow with dead child → lost): ${passed3 ? "PASS" : "FAIL"}`);
console.log(`Test 4 (cancel-requested flow → cancelled): ${passed4 ? "PASS" : "FAIL"}`);

const exitCode = (passed1 && passed2 && passed3 && passed4) ? 0 : 1;
process.exit(exitCode);
