#!/usr/bin/env npx tsx
/**
 * Mock Cursor API server for testing.
 *
 * This creates a local server that mimics the Cursor Background Agents API,
 * allowing you to test the integration without a real API key.
 *
 * Usage:
 *   npx tsx scripts/mock-cursor-api.ts
 *
 * Then configure your extension to use:
 *   apiKey: "mock-api-key"
 *   (The mock server accepts any API key)
 *
 * Override the API URL in tests by setting:
 *   CURSOR_API_BASE_URL=http://localhost:3456
 */

import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3456;
const WEBHOOK_SECRET = "mock-webhook-secret";

// In-memory storage for mock agents
const agents = new Map<
  string,
  {
    id: string;
    status: string;
    createdAt: string;
    prompt: { text: string };
    source: { repository: string; ref: string };
    webhookUrl?: string;
  }
>();

// Parse JSON body
async function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: any) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// Send webhook notification
async function sendWebhook(agent: any, status: string, extra: any = {}) {
  if (!agent.webhookUrl) {
    return;
  }

  const payload = JSON.stringify({
    event: "statusChange",
    timestamp: new Date().toISOString(),
    id: agent.id,
    status,
    source: agent.source,
    ...extra,
  });

  const signature = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");

  try {
    await fetch(agent.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-ID": `wh_${randomUUID()}`,
        "X-Webhook-Event": "statusChange",
        "User-Agent": "Cursor-Agent-Webhook/1.0 (Mock)",
      },
      body: payload,
    });
    console.log(`  → Sent webhook to ${agent.webhookUrl}`);
  } catch (error) {
    console.log(`  → Failed to send webhook: ${error}`);
  }
}

// Simulate agent execution
async function simulateAgent(agent: any) {
  // Update to RUNNING
  agent.status = "RUNNING";
  console.log(`  Agent ${agent.id} status: RUNNING`);
  await sendWebhook(agent, "RUNNING");

  // Simulate work (2-5 seconds)
  const workTime = 2000 + Math.random() * 3000;
  await new Promise((resolve) => setTimeout(resolve, workTime));

  // 90% success rate
  if (Math.random() < 0.9) {
    agent.status = "FINISHED";
    console.log(`  Agent ${agent.id} status: FINISHED`);
    await sendWebhook(agent, "FINISHED", {
      target: {
        url: `https://cursor.com/agents?id=${agent.id}`,
        branchName: `cursor/mock-${agent.id.slice(-6)}`,
        prUrl: `${agent.source.repository}/pull/${Math.floor(Math.random() * 1000)}`,
      },
      summary: `Completed task: ${agent.prompt.text.slice(0, 50)}...`,
    });
  } else {
    agent.status = "ERROR";
    console.log(`  Agent ${agent.id} status: ERROR`);
    await sendWebhook(agent, "ERROR", {
      error: "Simulated error for testing",
    });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  console.log(`${method} ${path}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Check authorization
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Route handlers
  try {
    // POST /v0/agents - Launch agent
    if (method === "POST" && path === "/v0/agents") {
      const body = await parseBody(req);

      if (!body.prompt?.text || !body.source?.repository) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required fields" }));
        return;
      }

      const id = `bc_mock_${randomUUID().slice(0, 8)}`;
      const agent = {
        id,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        prompt: body.prompt,
        source: body.source,
        webhookUrl: body.webhookUrl,
      };

      agents.set(id, agent);
      console.log(`  Created agent ${id}`);

      // Start async simulation
      void simulateAgent(agent);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, status: "PENDING" }));
      return;
    }

    // GET /v0/agents - List agents
    if (method === "GET" && path === "/v0/agents") {
      const list = Array.from(agents.values()).map((a) => ({
        id: a.id,
        status: a.status,
        createdAt: a.createdAt,
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    // GET /v0/agents/:id - Get agent details
    const detailsMatch = path.match(/^\/v0\/agents\/([^/]+)$/);
    if (method === "GET" && detailsMatch) {
      const agentId = detailsMatch[1];
      const agent = agents.get(agentId);

      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: agent.id,
          status: agent.status,
          createdAt: agent.createdAt,
          summary:
            agent.status === "FINISHED"
              ? `Completed: ${agent.prompt.text.slice(0, 50)}`
              : undefined,
          target:
            agent.status === "FINISHED"
              ? {
                  branchName: `cursor/mock-${agent.id.slice(-6)}`,
                }
              : undefined,
        }),
      );
      return;
    }

    // POST /v0/agents/:id/messages - Send follow-up
    const messagesMatch = path.match(/^\/v0\/agents\/([^/]+)\/messages$/);
    if (method === "POST" && messagesMatch) {
      const agentId = messagesMatch[1];
      const agent = agents.get(agentId);

      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return;
      }

      const body = await parseBody(req);
      console.log(`  Follow-up message for ${agentId}: ${body.text?.slice(0, 50)}...`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("Error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🤖 Mock Cursor API Server running on http://localhost:${PORT}\n`);
  console.log("Endpoints:");
  console.log("  POST /v0/agents          - Launch a new agent");
  console.log("  GET  /v0/agents          - List all agents");
  console.log("  GET  /v0/agents/:id      - Get agent details");
  console.log("  POST /v0/agents/:id/messages - Send follow-up\n");
  console.log(`Webhook secret: ${WEBHOOK_SECRET}\n`);
  console.log("Press Ctrl+C to stop.\n");
});
