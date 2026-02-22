#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = process.env.MC_TEST_BASE_URL || "http://127.0.0.1:3001";
const apiKey = process.env.MC_TEST_API_KEY || "";
const workspaceId = process.env.MC_TEST_WORKSPACE_ID || "golden";
const outputDir = path.resolve(process.cwd(), "output/playwright");
const CSRF_COOKIE_NAME = "mc_csrf";

let csrfToken = "";
let csrfCookie = "";

async function ensureCsrf() {
  if (csrfToken && csrfCookie) {return;}
  const response = await fetch(new URL("/api/csrf-token", baseUrl));
  if (!response.ok) {
    throw new Error(`Failed to initialize CSRF token: ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
  if (!match) {
    throw new Error("Missing CSRF cookie from /api/csrf-token");
  }
  csrfToken = decodeURIComponent(match[1]);
  csrfCookie = `${CSRF_COOKIE_NAME}=${match[1]}`;
}

/**
 * @param {string} route
 * @param {RequestInit & { auth?: boolean }} [init]
 */
async function request(route, init = {}) {
  const headers = new Headers(init.headers || {});
  const method = (init.method || "GET").toUpperCase();
  if (init.auth && apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    await ensureCsrf();
    headers.set("x-csrf-token", csrfToken);
    const existingCookie = headers.get("cookie");
    headers.set("cookie", [existingCookie, csrfCookie].filter(Boolean).join("; "));
  }

  const startedAt = Date.now();
  const response = await fetch(new URL(route, baseUrl), {
    ...init,
    headers,
  });
  const elapsedMs = Date.now() - startedAt;

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { status: response.status, elapsedMs, data };
}

/**
 * @param {number[]} values
 * @param {number} percentile
 */
function percentile(values, percentile) {
  if (values.length === 0) {return null;}
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

await fs.mkdir(outputDir, { recursive: true });

const endpointChecks = [
  {
    name: "tasks_list",
    route: `/api/tasks?workspace_id=${encodeURIComponent(workspaceId)}`,
    method: "GET",
    auth: true,
  },
  {
    name: "missions_list",
    route: `/api/missions?workspace_id=${encodeURIComponent(workspaceId)}`,
    method: "GET",
    auth: true,
  },
  { name: "agents_list", route: "/api/agents", method: "GET", auth: true },
  { name: "status", route: "/api/openclaw/status", method: "GET", auth: true },
  { name: "usage_today", route: "/api/openclaw/usage?period=today", method: "GET", auth: true },
  { name: "chat_sessions", route: "/api/chat/sessions?limit=10", method: "GET", auth: true },
];

const apiMatrix = [];
for (const check of endpointChecks) {
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    runs.push(await request(check.route, { method: check.method, auth: check.auth }));
  }
  const statuses = runs.map((run) => run.status);
  const latencies = runs.map((run) => run.elapsedMs);
  apiMatrix.push({
    endpoint: check.name,
    route: check.route,
    statuses,
    successCount: statuses.filter((status) => status < 400).length,
    errorCount: statuses.filter((status) => status >= 400).length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  });
}

const gatewayProbes = [];
for (let i = 0; i < 8; i += 1) {
  const probe = await request("/api/openclaw/status", { method: "GET", auth: true });
  gatewayProbes.push({
    status: probe.status,
    connected: Boolean(probe.data?.connected),
    at: new Date().toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const chatTimings = [];
for (let i = 0; i < 5; i += 1) {
  const sessionKey = `agent:main:baseline-audit-${Date.now()}-${i}`;
  const run = await request("/api/chat", {
    method: "POST",
    auth: true,
    body: JSON.stringify({
      sessionKey,
      message: `baseline chat latency probe ${i + 1}`,
    }),
  });
  chatTimings.push({
    status: run.status,
    elapsedMs: run.elapsedMs,
  });
}

let scrollAudit = null;
const scrollAuditPath = path.join(outputDir, "audit-scroll-chat-results.json");
try {
  const parsed = JSON.parse(await fs.readFile(scrollAuditPath, "utf8"));
  scrollAudit = {
    scenarios: Array.isArray(parsed) ? parsed.length : 0,
    source: scrollAuditPath,
  };
} catch {
  scrollAudit = {
    scenarios: 0,
    source: scrollAuditPath,
    note: "scroll audit results not found",
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  hasApiKey: Boolean(apiKey),
  workspaceId,
  apiMatrix,
  gatewayStability: {
    total: gatewayProbes.length,
    connectedCount: gatewayProbes.filter((probe) => probe.connected).length,
    disconnectedCount: gatewayProbes.filter((probe) => !probe.connected).length,
    probes: gatewayProbes,
  },
  chatLatency: {
    total: chatTimings.length,
    statuses: chatTimings.map((run) => run.status),
    p50Ms: percentile(chatTimings.map((run) => run.elapsedMs), 50),
    p95Ms: percentile(chatTimings.map((run) => run.elapsedMs), 95),
    samples: chatTimings,
  },
  ciStatus: {
    requiredGates: [
      "lint",
      "build",
      "audit:scroll-chat:ci",
      "test:api-contract",
      "test:chat-e2e",
      "docs-gate",
    ],
  },
  scrollAudit,
};

const outputPath = path.join(outputDir, "baseline-audit.json");
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Baseline audit generated: ${outputPath}`);
