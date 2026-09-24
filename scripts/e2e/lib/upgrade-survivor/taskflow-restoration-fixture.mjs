import assert from "node:assert/strict";

export const TASKFLOW_PLUGIN_ID = "taskflow-survivor";
export const TASKFLOW_PLUGIN_MANIFEST = {
  id: TASKFLOW_PLUGIN_ID,
  activation: { onStartup: true },
  configSchema: { type: "object", properties: {}, additionalProperties: false },
};
export const TASKFLOW_METHOD = "taskflow-survivor.read";
export const TASKFLOW_OWNER = "agent:main:taskflow-update-cell";
export const TASKFLOW_TASK_IDS = [1, 2, 3].map((index) => `update-cell-task-0${index}`);
export const TASKFLOW_FLOW_IDS = ["update-cell-flow-managed", "update-cell-flow-mirrored"];

export function createTaskflowFixture(now) {
  assert(Number.isSafeInteger(now) && now > 3003, "Invalid fixture timestamp");
  const tasks = TASKFLOW_TASK_IDS.map((taskId, offset) => {
    const index = offset + 1;
    return {
      taskId,
      runtime: "cli",
      sourceId: `update-cell-source-${index}`,
      requesterSessionKey: TASKFLOW_OWNER,
      ownerKey: TASKFLOW_OWNER,
      scopeKind: "session",
      parentFlowId: TASKFLOW_FLOW_IDS[index === 3 ? 1 : 0],
      agentId: "main",
      requesterAgentId: "main",
      runId: `update-cell-run-0${index}`,
      ...(index < 3 ? { childSessionKey: `agent:main:taskflow-child-0${index}` } : {}),
      label: `Task/flow survivor ${index} — 東京`,
      task: `Task/flow survivor ${index} — 東京`,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: now - 3000 - index,
      startedAt: now - 2000 - index,
      endedAt: now - 1000 - index,
      lastEventAt: now - 1000 - index,
      cleanupAfter: now + 86_400_000,
      toolUseCount: index,
      lastToolName: "synthetic-fixture",
      progressSummary: `Progress ${index} — 東京`,
      terminalSummary: `Completed ${index} — 東京`,
      terminalOutcome: "succeeded",
      detail: {
        fixture: "taskflow-update-cell",
        index,
        payload: { enabled: true, optional: null },
        tags: ["persisted", "東京"],
      },
    };
  });
  const flows = TASKFLOW_FLOW_IDS.map((flowId, index) => {
    const flow = {
      flowId,
      syncMode: index === 0 ? "managed" : "task_mirrored",
      ownerKey: TASKFLOW_OWNER,
      revision: index === 0 ? 7 : 3,
      status: "succeeded",
      notifyPolicy: "silent",
      goal: `Flow survivor ${index} — 東京`,
      currentStep: "Complete",
      stateJson: { fixture: "taskflow-update-cell", index, payload: [true, null, "東京"] },
      createdAt: now - 4000 - index,
      updatedAt: tasks[index === 0 ? 0 : 2].endedAt,
      endedAt: tasks[index === 0 ? 0 : 2].endedAt,
    };
    if (index === 0) {
      flow.controllerId = "update-cell-controller";
    }
    return flow;
  });
  const deliveryStates = tasks.map((task) => ({
    taskId: task.taskId,
    lastNotifiedEventAt: task.endedAt,
  }));
  return { tasks, flows, deliveryStates };
}

// Compare JSON-visible owner records; optional absent fields are not durable values.
export function normalizeTaskflowSnapshot(snapshot) {
  return Object.fromEntries(
    ["tasks", "flows", "deliveryStates"].map((key) => {
      const id = key === "flows" ? "flowId" : "taskId";
      const records = snapshot[key] instanceof Map ? [...snapshot[key].values()] : snapshot[key];
      assert(Array.isArray(records), `Missing ${key} snapshot`);
      const serializedRecords = JSON.stringify(records);
      return [key, JSON.parse(serializedRecords).toSorted((a, b) => a[id].localeCompare(b[id]))];
    }),
  );
}

export function assertTaskflowSnapshot(actual, expected) {
  assert.deepEqual(normalizeTaskflowSnapshot(actual), normalizeTaskflowSnapshot(expected));
}

export function assertTaskflowIdentifiers(actual, fixture) {
  assert.deepEqual(
    actual,
    fixture.tasks.map((task) => ({
      task_id: task.taskId,
      run_id: task.runId,
      child_session_key: task.childSessionKey ?? null,
    })),
    "Task identifiers must be canonical before the candidate Gateway starts",
  );
}

function runView(task) {
  const { taskId, requesterSessionKey, scopeKind, parentFlowId, task: title } = task;
  const fields = [
    "runtime",
    "sourceId",
    "ownerKey",
    "agentId",
    "runId",
    "label",
    "status",
    "deliveryStatus",
    "notifyPolicy",
    "createdAt",
    "startedAt",
    "endedAt",
    "lastEventAt",
    "cleanupAfter",
    "progressSummary",
    "terminalSummary",
    "terminalOutcome",
  ];
  return {
    id: taskId,
    sessionKey: requesterSessionKey,
    scope: scopeKind,
    flowId: parentFlowId,
    title,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...Object.fromEntries(fields.map((key) => [key, task[key]])),
  };
}

function flowView(flow) {
  return {
    id: flow.flowId,
    ...Object.fromEntries(
      [
        "ownerKey",
        "status",
        "notifyPolicy",
        "goal",
        "currentStep",
        "createdAt",
        "updatedAt",
        "endedAt",
      ].map((key) => [key, flow[key]]),
    ),
  };
}

function summary(total) {
  return {
    total,
    active: 0,
    terminal: total,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: total,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: { subagent: 0, acp: 0, cron: 0, cli: total },
  };
}

export function assertTaskflowSdkReads(actual, fixture) {
  assert.equal(actual.ownerKey, TASKFLOW_OWNER);
  const runs = fixture.tasks.map(runView);
  assert.deepEqual(actual.runs, runs);
  assert.deepEqual(actual.runDetails, runs);
  assert.deepEqual(actual.resolvedRuns, runs);
  assert.deepEqual(actual.flows, fixture.flows.map(flowView));
  assert.deepEqual(actual.managedFlow, fixture.flows[0]);
  for (const [index, flow] of fixture.flows.entries()) {
    const tasks = fixture.tasks.filter((task) => task.parentFlowId === flow.flowId).map(runView);
    assert.deepEqual(actual.flowDetails[index], {
      ...flowView(flow),
      state: flow.stateJson,
      tasks,
      taskSummary: summary(tasks.length),
    });
    assert.deepEqual(actual.flowSummaries[index], summary(tasks.length));
  }
}

export function assertTaskflowGatewayReads(pages, details, fixture) {
  assert.equal(pages.length, 2);
  assert.equal(pages[0].tasks.length, 2);
  assert.equal(pages[1].tasks.length, 1);
  assert.equal(typeof pages[0].nextCursor, "string");
  assert(pages[0].nextCursor.length > 0);
  assert.equal(pages[1].nextCursor, undefined);
  assert.deepEqual(
    pages.flatMap((page) => page.tasks.map((task) => task.id)),
    TASKFLOW_TASK_IDS,
  );
  assert.equal(details.length, fixture.tasks.length);
  for (const [index, task] of fixture.tasks.entries()) {
    const listed = pages.flatMap((page) => page.tasks)[index];
    const detailed = details[index].task;
    for (const result of [listed, detailed]) {
      assert.equal(result.id, task.taskId);
      assert.equal(result.taskId, task.taskId);
      assert.equal(result.title, task.label);
      assert.equal(result.kind, task.runtime);
      assert.equal(result.status, "completed");
      assert.equal(result.execution.state, "finished");
      for (const key of [
        "runtime",
        "ownerKey",
        "agentId",
        "runId",
        "childSessionKey",
        "sourceId",
        "createdAt",
        "startedAt",
        "endedAt",
        "toolUseCount",
        "lastToolName",
        "progressSummary",
        "terminalSummary",
        "deliveryStatus",
        "terminalOutcome",
      ]) {
        assert.deepEqual(result[key], task[key], `Gateway ${task.taskId}.${key}`);
      }
      assert.equal(result.flowId, task.parentFlowId);
      assert.equal(result.sessionKey, task.requesterSessionKey);
      assert.equal(result.updatedAt, task.lastEventAt);
      // A recorded session key exposes a history route even without a transcript.
      assert.equal(result.hasTranscript, true);
    }
    assert.equal(detailed.prompt, task.task);
    assert.equal(detailed.result, task.terminalSummary);
    assert.equal(listed.prompt, undefined);
  }
}
