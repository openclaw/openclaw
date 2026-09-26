#!/usr/bin/env node

import { readBoundedResponseText } from "../../../lib/bounded-response.mjs";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535 || process.argv.length !== 3) {
  throw new Error("Expected one Gateway port");
}

const probes = {};
for (const endpoint of ["/readyz", "/startupz"]) {
  const signal = AbortSignal.timeout(2_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      signal,
      redirect: "error",
    });
    const text = await readBoundedResponseText(response, endpoint, 16 * 1024, { signal });
    const body = JSON.parse(text);
    const details = {};
    for (const field of ["ready", "ok"]) {
      if (typeof body?.[field] === "boolean") {
        details[field] = body[field];
      }
    }
    for (const field of ["status", "pendingReason", "version"]) {
      if (typeof body?.[field] === "string") {
        details[field] = body[field];
      }
    }
    if (Number.isFinite(body?.uptimeMs) && body.uptimeMs >= 0) {
      details.uptimeMs = body.uptimeMs;
    }
    if (Array.isArray(body?.failing) && body.failing.every((item) => typeof item === "string")) {
      details.failing = body.failing;
    }
    probes[endpoint] = { availability: "captured", httpStatus: response.status, body: details };
  } catch {
    probes[endpoint] = {
      availability: "unavailable",
      reason: signal.aborted ? "request timed out" : "request or bounded JSON body unavailable",
    };
  }
}

// This observation follows a failed readiness wait; it cannot change that outcome.
process.stdout.write(`${JSON.stringify({ afterReadinessFailure: true, probes })}\n`);
