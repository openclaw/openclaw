/**
 * A2A plugin integration test — starts a minimal HTTP server and
 * verifies Agent Card + JSON-RPC endpoints against the A2A spec.
 */
import http from "node:http";
import { buildAgentCard } from "./agent-card.js";
import {
  parseJsonRpc,
  formatResponse,
  formatJsonRpcError,
  isNotification,
  JSONRPC_ERROR,
  type JsonRpcRequest,
} from "./jsonrpc.js";
import { createTask, getTask } from "./tasks.js";

// ── mini test server ──────────────────────────────────────────────────

function createTestServer(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // Agent Card
      if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
        const card = buildAgentCard({
          agents: [
            { id: "main", description: "Test agent" },
          ],
          gatewayUrl: `http://localhost:${port}`,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(card));
        return;
      }

      // JSON-RPC tasks/send
      if (req.method === "POST" && url.pathname === "/a2a/tasks/send") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          const parsed = parseJsonRpc(body);
          if ("code" in parsed) {
            const err = formatJsonRpcError(null, parsed.code, parsed.message);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(err));
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((r) => handleRpc(r));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(results));
            return;
          }
          const result = handleRpc(parsed);
          if (isNotification(parsed)) {
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        });
        return;
      }

      // Task status
      if (req.method === "GET" && url.pathname.startsWith("/a2a/tasks/")) {
        const taskId = url.pathname.slice("/a2a/tasks/".length);
        const task = getTask(taskId);
        if (!task) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: task.id,
          state: task.state,
          sessionKey: task.sessionKey,
        }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(port, () => resolve(server));
  });
}

function handleRpc(req: JsonRpcRequest): Record<string, unknown> {
  if (req.method === "tasks/send") {
    const params = req.params as Record<string, unknown> | undefined;
    const task = createTask(`agent:main:explicit:${Date.now()}`);
    return formatResponse(req.id, {
      taskId: task.id,
      state: "working",
      sessionKey: task.sessionKey,
    }) as unknown as Record<string, unknown>;
  }
  return formatJsonRpcError(
    req.id,
    JSONRPC_ERROR.METHOD_NOT_FOUND.code,
    `Method not found: ${req.method}`,
  ) as unknown as Record<string, unknown>;
}

// ── test runner ───────────────────────────────────────────────────────

async function run() {
  const PORT = 19876;
  const server = await createTestServer(PORT);
  const BASE = `http://localhost:${PORT}`;

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}: ${err}`);
    }
  }

  // ── Agent Card tests ──────────────────────────────────────────────

  await test("GET /.well-known/agent.json returns 200", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const card = await res.json();
    if (card.name !== "OpenClaw") throw new Error(`name: ${card.name}`);
    if (!card.url) throw new Error("missing url");
    if (!card.skills || card.skills.length === 0) throw new Error("no skills");
    if (card.skills[0].id !== "main") throw new Error(`skill id: ${card.skills[0].id}`);
    if (!card.capabilities.streaming) throw new Error("streaming missing");
  });

  await test("Agent Card has required fields", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    const card = await res.json();
    const required = ["name", "description", "url", "capabilities", "skills"];
    for (const field of required) {
      if (!(field in card)) throw new Error(`missing field: ${field}`);
    }
  });

  // ── JSON-RPC tests ────────────────────────────────────────────────

  await test("POST /a2a/tasks/send creates task", async () => {
    const res = await fetch(`${BASE}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: { message: "Hello, A2A!" },
      }),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (body.jsonrpc !== "2.0") throw new Error("not jsonrpc 2.0");
    if (body.id !== 1) throw new Error(`id: ${body.id}`);
    if (!body.result?.taskId) throw new Error("no taskId");
    if (body.result.state !== "working") throw new Error(`state: ${body.result.state}`);
    if (!body.result.sessionKey) throw new Error("no sessionKey");
  });

  await test("JSON-RPC batch request", async () => {
    const res = await fetch(`${BASE}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tasks/send", params: { message: "A" } },
        { jsonrpc: "2.0", id: 2, method: "tasks/send", params: { message: "B" } },
      ]),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("not array");
    if (body.length !== 2) throw new Error(`length: ${body.length}`);
    if (body[0].result.taskId === body[1].result.taskId) throw new Error("duplicate taskId in batch");
  });

  await test("JSON-RPC notification (no id)", async () => {
    const res = await fetch(`${BASE}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/send",
        params: { message: "silent" },
      }),
    });
    if (res.status !== 204) throw new Error(`expected 204, got ${res.status}`);
  });

  await test("JSON-RPC unknown method", async () => {
    const res = await fetch(`${BASE}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/unknown",
      }),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (!body.error || body.error.code !== -32601) throw new Error("expected -32601");
  });

  // ── Task status test ─────────────────────────────────────────────

  await test("GET /a2a/tasks/:id returns task status", async () => {
    // First create a task
    const createRes = await fetch(`${BASE}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: { message: "status test" },
      }),
    });
    const createBody = await createRes.json();
    const taskId = createBody.result.taskId;

    // Then read it
    const res = await fetch(`${BASE}/a2a/tasks/${taskId}`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (body.id !== taskId) throw new Error(`id mismatch: ${body.id}`);
    if (body.state !== "working") throw new Error(`state: ${body.state}`);
    if (!body.sessionKey) throw new Error("missing sessionKey");
  });

  await test("GET /a2a/tasks/:id returns 404 for unknown", async () => {
    const res = await fetch(`${BASE}/a2a/tasks/nonexistent-task-id`);
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
