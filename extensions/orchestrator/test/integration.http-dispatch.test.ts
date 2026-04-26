// End-to-end integration test for the openclaw-side data plane:
//
//   HTTP submit  →  routing engine (real)  →  store (real, tmpdir)
//                →  dispatch (real, synthetic mode)  →  trajectory recorder (real, sidecar JSONL)
//                →  HTTP transition (approve)  →  store (real CAS)
//
// No mocks of the dispatch path or routing engine. The store, recorder,
// and routing engine are constructed with their real implementations;
// only the IncomingMessage / ServerResponse pair is faked because we
// don't want to bind a real socket.
//
// The test verifies the full lifecycle of one task — the same path
// Mission Control's `/api/orchestrator/submit` and `/transition` proxy
// routes drive in production.

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OrchestratorCredentials } from "../src/credentials.js";
import { dispatchTask } from "../src/dispatch.js";
import { createOrchestratorHttpHandler, type DispatchMode } from "../src/http.js";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.config-default.js";
import { loadConfig, type CompiledRoutingConfig } from "../src/routing.js";
import { createStore, type Store } from "../src/store.js";
import {
  __resetRecorderRegistry,
  getRecorder,
  type TaskTrajectoryEvent,
  type TrajectoryRecorder,
} from "../src/trajectory.js";
import type { Task } from "../src/types/schema.js";

const TOKEN = "f".repeat(64);

const credentials: OrchestratorCredentials = {
  version: 1,
  token: TOKEN,
  createdAt: new Date(0).toISOString(),
};

let tmpHome: string;
let routingPath: string;
let sessionsDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-integration-"));
  routingPath = join(tmpHome, "routing.json");
  writeFileSync(routingPath, JSON.stringify(DEFAULT_ROUTING_CONFIG, null, 2));
  sessionsDir = join(tmpHome, "agents", "fleet-orchestrator", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  sessionFile = join(sessionsDir, "integration-session.jsonl");
  __resetRecorderRegistry();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  __resetRecorderRegistry();
});

interface FakeRes {
  statusCode: number;
  body: string;
}

function fakeRes(): {
  res: import("node:http").ServerResponse;
  capture: () => FakeRes;
} {
  const captured: FakeRes = { statusCode: 0, body: "" };
  const res = {
    statusCode: 0,
    setHeader() {
      // ignore for the integration test
    },
    end(body?: string) {
      captured.body = body ?? "";
      captured.statusCode = (this as { statusCode: number }).statusCode;
    },
  } as unknown as import("node:http").ServerResponse;
  return { res, capture: () => captured };
}

interface ReqInit {
  method: string;
  url: string;
  body?: unknown;
}

function fakeReq(init: ReqInit): import("node:http").IncomingMessage {
  const emitter = new EventEmitter() as unknown as import("node:http").IncomingMessage & {
    emit: EventEmitter["emit"];
  };
  emitter.method = init.method;
  emitter.url = init.url;
  emitter.headers = { authorization: `Bearer ${TOKEN}` };
  if (init.body !== undefined) {
    setImmediate(() => {
      emitter.emit("data", Buffer.from(JSON.stringify(init.body), "utf8"));
      emitter.emit("end");
    });
  } else {
    setImmediate(() => emitter.emit("end"));
  }
  return emitter;
}

function compile(): CompiledRoutingConfig {
  const { config } = loadConfig({ path: routingPath, skipAgentValidation: true });
  return config;
}

function buildHandler(
  mode: DispatchMode,
  store: Store,
  recorder: TrajectoryRecorder,
): ReturnType<typeof createOrchestratorHttpHandler> {
  const config = compile();
  return createOrchestratorHttpHandler({
    store,
    routingConfig: config,
    credentials,
    mode,
    dispatch: async (task: Task): Promise<Task> => {
      const result = dispatchTask(task, store, {
        config,
        mode,
        recorder,
      });
      return result.task;
    },
  });
}

async function call(
  handler: ReturnType<typeof createOrchestratorHttpHandler>,
  init: ReqInit,
): Promise<FakeRes> {
  const { res, capture } = fakeRes();
  await handler(fakeReq(init), res);
  return capture();
}

function readTrajectoryEvents(path: string): TaskTrajectoryEvent[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TaskTrajectoryEvent);
}

describe("HTTP → dispatch → approval round-trip (synthetic mode)", () => {
  test("an approval-required task moves through the full state machine end-to-end", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("synthetic", store, recorder);

    // 1. Submit via HTTP.
    const submitRes = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      body: { goal: "please debug this function", submittedBy: "tester" },
    });
    expect(submitRes.statusCode).toBe(201);
    const submitBody = JSON.parse(submitRes.body) as { task: Task };
    const taskId = submitBody.task.id;
    expect(submitBody.task.state).toBe("awaiting_approval");
    expect(submitBody.task.assignedAgentId).toBe("coder");

    // 2. The task is persisted to disk by the real store.
    const onDisk = store.read(taskId);
    expect(onDisk.state).toBe("awaiting_approval");
    expect(onDisk.routing?.matchedRuleId).toBe("code-tasks");

    // 3. Trajectory sidecar contains the full synthetic-mode event family.
    const events = readTrajectoryEvents(recorder.sidecarPath);
    expect(events.map((e) => e.type)).toEqual([
      "task.queued",
      "task.assigned",
      "task.in_progress",
      "task.awaiting_approval",
    ]);
    for (const event of events) {
      expect(event.data.taskId).toBe(taskId);
    }

    // 4. GET the task back via HTTP.
    const getRes = await call(handler, {
      method: "GET",
      url: `/orchestrator/tasks/${taskId}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).task.id).toBe(taskId);

    // 5. Approve via HTTP.
    const approveRes = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${taskId}/transition`,
      body: { action: "approve", by: "operator" },
    });
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body).task as Task;
    expect(approved.state).toBe("done");
    expect(approved.completedAt).not.toBeNull();

    // 6. Final disk state is `done` with completedAt set.
    const final = store.read(taskId);
    expect(final.state).toBe("done");
  });

  test("a non-approval-required task lands at done without operator action", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("synthetic", store, recorder);

    const submitRes = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      body: { goal: "research the literature", submittedBy: "tester" },
    });
    expect(submitRes.statusCode).toBe(201);
    const task = JSON.parse(submitRes.body).task as Task;
    expect(task.state).toBe("done");
    expect(task.assignedAgentId).toBe("researcher");

    const events = readTrajectoryEvents(recorder.sidecarPath);
    expect(events.map((e) => e.type)).toContain("task.done");
    expect(events.map((e) => e.type)).not.toContain("task.awaiting_approval");
  });

  test("rejection records both rejection and error fields", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("synthetic", store, recorder);

    const submitRes = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      body: { goal: "fix this bug", submittedBy: "tester" },
    });
    const taskId = (JSON.parse(submitRes.body) as { task: Task }).task.id;

    const rejectRes = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${taskId}/transition`,
      body: { action: "reject", reason: "wrong agent", by: "operator" },
    });
    expect(rejectRes.statusCode).toBe(200);
    const rejected = JSON.parse(rejectRes.body).task as Task;
    expect(rejected.state).toBe("failed");
    expect(rejected.rejection?.reason).toBe("wrong agent");
    expect(rejected.error?.code).toBe("rejected");
  });

  test("listing returns the round-tripped tasks and filters by state", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("synthetic", store, recorder);

    await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      body: { goal: "research X", submittedBy: "tester" },
    });
    await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      body: { goal: "fix this bug", submittedBy: "tester" },
    });

    const listAll = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks?kind=synthetic",
    });
    expect(JSON.parse(listAll.body).tasks.length).toBe(2);

    const awaiting = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks?kind=synthetic&state=awaiting_approval",
    });
    expect(JSON.parse(awaiting.body).tasks.length).toBe(1);
    expect(JSON.parse(awaiting.body).tasks[0].assignedAgentId).toBe("coder");
  });

  test("routing preview is pure — does not touch the store or trajectory", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("synthetic", store, recorder);

    const previewRes = await call(handler, {
      method: "GET",
      url: "/orchestrator/routing/preview?goal=please%20debug%20this",
    });
    expect(previewRes.statusCode).toBe(200);
    expect(JSON.parse(previewRes.body).decision.assignedAgentId).toBe("coder");
    expect(store.list({ kind: "synthetic" })).toEqual([]);
    expect(() => readTrajectoryEvents(recorder.sidecarPath)).toThrow();
  });

  test("live mode rejects POST submission with 403 LIVE_DISABLED", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("live", store, recorder);

    const res = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      body: { goal: "hi" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("LIVE_DISABLED");
    expect(store.list({ kind: "synthetic" })).toEqual([]);
  });

  test("approve on a queued task returns 409 invalid_transition without mutating state", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({
      sessionId: "integration-session",
      sessionFile,
    });
    const handler = buildHandler("synthetic", store, recorder);

    const queued = store.submit({ goal: "x", submittedBy: "tester" });
    const res = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${queued.id}/transition`,
      body: { action: "approve" },
    });
    expect(res.statusCode).toBe(409);
    expect(store.read(queued.id).state).toBe("queued");
  });
});
