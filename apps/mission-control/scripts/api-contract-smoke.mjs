#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = process.env.MC_TEST_BASE_URL || "http://127.0.0.1:3001";
const apiKey = process.env.MC_TEST_API_KEY || "";
const outputDir = path.resolve(process.cwd(), "output/playwright");
const CSRF_COOKIE_NAME = "mc_csrf";

let csrfToken = "";
let csrfCookie = "";

async function ensureCsrf() {
  if (csrfToken && csrfCookie) {return;}
  const headers = new Headers();
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const response = await fetch(new URL("/api/csrf-token", baseUrl), {
    headers,
  });
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

  return { response, data, elapsedMs };
}

/**
 * @param {string} name
 * @param {boolean} pass
 * @param {Record<string, unknown>} details
 */
function result(name, pass, details) {
  return { name, pass, ...details };
}

await fs.mkdir(outputDir, { recursive: true });

const results = [];
let failed = false;

// 1) Unauthorized access rejected when API key auth is configured for smoke tests.
if (apiKey) {
  const unauth = await request("/api/tasks");
  const pass = unauth.response.status === 401;
  results.push(
    result("unauthorized_access_rejected", pass, {
      status: unauth.response.status,
      elapsedMs: unauth.elapsedMs,
    })
  );
  if (!pass) {failed = true;}
} else {
  results.push(
    result("unauthorized_access_rejected", true, {
      skipped: true,
      reason: "MC_TEST_API_KEY not provided",
    })
  );
}

// 2) Invalid payload returns 400.
const invalidPayload = await request("/api/tasks", {
  method: "POST",
  auth: true,
  body: JSON.stringify({ title: "" }),
});
const invalidPayloadPass =
  invalidPayload.response.status === 400 &&
  Boolean(invalidPayload.data && (invalidPayload.data.error || invalidPayload.data.errorInfo));
results.push(
  result("invalid_payload_returns_400", invalidPayloadPass, {
    status: invalidPayload.response.status,
    elapsedMs: invalidPayload.elapsedMs,
    body: invalidPayload.data,
  })
);
if (!invalidPayloadPass) {failed = true;}

// 3) Tools endpoint blocks non-allowlisted methods.
const blockedMethod = await request("/api/openclaw/tools", {
  method: "POST",
  auth: true,
  body: JSON.stringify({
    tool: "dangerous.delete_all",
    args: {},
  }),
});
const blockedMethodPass = blockedMethod.response.status === 403;
results.push(
  result("tools_blocks_disallowed_method", blockedMethodPass, {
    status: blockedMethod.response.status,
    elapsedMs: blockedMethod.elapsedMs,
    body: blockedMethod.data,
  })
);
if (!blockedMethodPass) {failed = true;}

// 4) Provider fallback/degraded behavior should be controlled (never crash route).
const gatewayStatus = await request("/api/openclaw/status", { auth: true });
const connected = Boolean(gatewayStatus.data?.connected);

if (connected) {
  const chatAttempt = await request("/api/chat", {
    method: "POST",
    auth: true,
    body: JSON.stringify({
      message: "provider fallback smoke test",
      model: "anthropic/disabled-smoke-model",
    }),
  });

  const chatPass = chatAttempt.response.status !== 500;
  results.push(
    result("provider_degraded_path_no_500", chatPass, {
      status: chatAttempt.response.status,
      elapsedMs: chatAttempt.elapsedMs,
      body: chatAttempt.data,
    })
  );
  if (!chatPass) {failed = true;}
} else {
  results.push(
    result("provider_degraded_path_no_500", true, {
      skipped: true,
      reason: "Gateway not connected in this environment",
    })
  );
}

const outputPath = path.join(outputDir, "api-contract-smoke-results.json");
await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

const summary = {
  total: results.length,
  failed: results.filter((r) => !r.pass).length,
};

console.log(`API contract smoke summary: ${JSON.stringify(summary)}`);
console.log(`Details: ${outputPath}`);

if (failed) {
  process.exit(1);
}
