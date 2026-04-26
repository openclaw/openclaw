import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OrchestratorCredentials } from "../src/credentials.js";
import { createOrchestratorHttpHandler } from "../src/http.js";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.config-default.js";
import type { CompiledRoutingConfig } from "../src/routing.js";
import { createStore, type Store } from "../src/store.js";
import type { Task } from "../src/types/schema.js";

const TOKEN = "f".repeat(64);

const credentials: OrchestratorCredentials = {
  version: 1,
  token: TOKEN,
  createdAt: new Date(0).toISOString(),
};

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-http-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function compile(): CompiledRoutingConfig {
  return {
    schemaVersion: 1,
    rules: DEFAULT_ROUTING_CONFIG.rules.map((rule) => ({
      ...rule,
      regex: new RegExp(rule.pattern, "i"),
    })),
    default: DEFAULT_ROUTING_CONFIG.default,
    approvalRequired: DEFAULT_ROUTING_CONFIG.approvalRequired,
    approvalRequiredCapabilities: DEFAULT_ROUTING_CONFIG.approvalRequiredCapabilities,
  };
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): {
  res: import("node:http").ServerResponse;
  capture: () => FakeRes;
  ended: () => boolean;
} {
  const captured: FakeRes = {
    statusCode: 0,
    headers: {},
    body: "",
  };
  let isEnded = false;
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      captured.body = body ?? "";
      captured.statusCode = (this as { statusCode: number }).statusCode;
      isEnded = true;
    },
  } as unknown as import("node:http").ServerResponse;
  return { res, capture: () => captured, ended: () => isEnded };
}

interface ReqInit {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function makeReq(init: ReqInit): import("node:http").IncomingMessage {
  const emitter = new EventEmitter() as unknown as import("node:http").IncomingMessage & {
    on: EventEmitter["on"];
    emit: EventEmitter["emit"];
  };
  emitter.method = init.method;
  emitter.url = init.url;
  emitter.headers = init.headers ?? {};
  // Allow handlers to attach listeners before we emit the body. Using
  // setImmediate avoids a microtask-ordering trap where the listener
  // hasn't been attached yet.
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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function call(
  handler: ReturnType<typeof createOrchestratorHttpHandler>,
  init: ReqInit,
): Promise<FakeRes> {
  const { res, capture } = makeRes();
  const req = makeReq(init);
  await handler(req, res);
  return capture();
}

function makeHandler(
  store: Store,
  options: Partial<Parameters<typeof createOrchestratorHttpHandler>[0]> = {},
): ReturnType<typeof createOrchestratorHttpHandler> {
  return createOrchestratorHttpHandler({
    store,
    routingConfig: compile(),
    credentials,
    mode: "synthetic",
    ...options,
  });
}

describe("GET /orchestrator/health", () => {
  test("is public and returns mode + version", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, { method: "GET", url: "/orchestrator/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      mode: "synthetic",
      hasCredentials: true,
    });
  });
});

describe("auth", () => {
  test("returns 503 when credentials are not initialized", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }), {
      credentials: null,
    });
    const res = await call(handler, { method: "GET", url: "/orchestrator/tasks" });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("ORCHESTRATOR_NOT_INITIALIZED");
  });

  test("returns 401 with no Authorization header", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, { method: "GET", url: "/orchestrator/tasks" });
    expect(res.statusCode).toBe(401);
  });

  test("returns 401 with the wrong token", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("accepts the right token", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /orchestrator/routing/preview", () => {
  test("returns the deterministic decision for a goal", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/routing/preview?goal=please%20debug%20this",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).decision.assignedAgentId).toBe("coder");
  });

  test("requires goal", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/routing/preview",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  test("does not create any task", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const handler = makeHandler(store);
    await call(handler, {
      method: "GET",
      url: "/orchestrator/routing/preview?goal=debug%20bug",
      headers: authHeaders(),
    });
    expect(store.list().length).toBe(0);
  });
});

describe("POST /orchestrator/tasks", () => {
  test("synthetic mode creates a queued task and runs the dispatcher", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const dispatched: Task[] = [];
    const handler = makeHandler(store, {
      dispatch: async (task) => {
        dispatched.push(task);
        return task;
      },
    });
    const res = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
      body: { goal: "please debug this", submittedBy: "tester" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).task.goal).toBe("please debug this");
    expect(dispatched.length).toBe(1);
  });

  test("rejects empty goal", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
      body: { goal: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("missing_goal");
  });

  test("rejects oversized goal", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
      body: { goal: "x".repeat(8 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("goal_too_long");
  });

  test("returns 403 LIVE_DISABLED when mode is live or shadow", async () => {
    for (const mode of ["live", "shadow"] as const) {
      const handler = makeHandler(createStore({ openclawHome: tmpHome }), {
        mode,
      });
      const res = await call(handler, {
        method: "POST",
        url: "/orchestrator/tasks",
        headers: authHeaders(),
        body: { goal: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("LIVE_DISABLED");
    }
  });

  test("missing body returns 400", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "POST",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("missing_body");
  });
});

describe("GET /orchestrator/tasks (list)", () => {
  test("returns submitted tasks", async () => {
    const store = createStore({ openclawHome: tmpHome });
    store.submit({ goal: "a", submittedBy: "tester" });
    store.submit({ goal: "b", submittedBy: "tester" });
    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tasks.length).toBe(2);
  });

  test("filters by state", async () => {
    const store = createStore({ openclawHome: tmpHome });
    store.submit({ goal: "x", submittedBy: "tester" });
    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks?state=queued",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tasks.length).toBe(1);
  });

  test("invalid state returns 400", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks?state=bogus",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /orchestrator/tasks/:id", () => {
  test("returns the requested task", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "GET",
      url: `/orchestrator/tasks/${t.id}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).task.id).toBe(t.id);
  });

  test("404 for missing task", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/tasks/does-not-exist",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /orchestrator/tasks/:id/transition", () => {
  test("approves an awaiting_approval task", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    store.transition(t.id, {
      type: "route",
      routing: {
        matchedRuleId: "code-tasks",
        assignedAgentId: "coder",
        capabilityMatches: [],
        fallbackUsed: false,
        decidedAt: new Date().toISOString(),
      },
    });
    store.transition(t.id, { type: "start", specialistSessionId: "s" });
    store.transition(t.id, {
      type: "complete",
      requiresApproval: true,
      result: {
        text: "done",
        textPath: null,
        artefacts: [],
        specialistSessionId: "s",
      },
    });

    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${t.id}/transition`,
      headers: authHeaders(),
      body: { action: "approve", by: "operator" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).task.state).toBe("done");
  });

  test("rejects with reason transitions to failed", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    store.transition(t.id, {
      type: "route",
      routing: {
        matchedRuleId: "code-tasks",
        assignedAgentId: "coder",
        capabilityMatches: [],
        fallbackUsed: false,
        decidedAt: new Date().toISOString(),
      },
    });
    store.transition(t.id, { type: "start", specialistSessionId: "s" });
    store.transition(t.id, {
      type: "complete",
      requiresApproval: true,
      result: {
        text: "x",
        textPath: null,
        artefacts: [],
        specialistSessionId: "s",
      },
    });

    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${t.id}/transition`,
      headers: authHeaders(),
      body: { action: "reject", reason: "wrong agent", by: "op" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).task.state).toBe("failed");
  });

  test("invalid_action returns 400", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${t.id}/transition`,
      headers: authHeaders(),
      body: { action: "explode" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("invalid_action");
  });

  test("invalid_transition (e.g. approve a queued task) returns 409", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${t.id}/transition`,
      headers: authHeaders(),
      body: { action: "approve" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("invalid_transition");
  });

  test("missing reason on reject returns 400", async () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    const handler = makeHandler(store);
    const res = await call(handler, {
      method: "POST",
      url: `/orchestrator/tasks/${t.id}/transition`,
      headers: authHeaders(),
      body: { action: "reject" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("invalid_reason");
  });
});

describe("unknown / wrong-method paths", () => {
  test("returns false for paths outside /orchestrator/", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const { res, ended } = makeRes();
    const result = await handler(makeReq({ method: "GET", url: "/unrelated/path" }), res);
    expect(result).toBe(false);
    expect(ended()).toBe(false);
  });

  test("returns 405 for wrong method on a known path", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "DELETE",
      url: "/orchestrator/tasks",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(405);
  });

  test("returns 404 for an unknown sub-path under /orchestrator/", async () => {
    const handler = makeHandler(createStore({ openclawHome: tmpHome }));
    const res = await call(handler, {
      method: "GET",
      url: "/orchestrator/totally-unknown",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});
