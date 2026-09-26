#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedResponseText } from "../../../lib/bounded-response.mjs";

const port = Number(process.argv[2]);
const gatewayPid = Number(process.argv[3]);
const artifactRoot = process.argv[4];
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  ![3, 5].includes(process.argv.length) ||
  (process.argv.length === 5 &&
    (!Number.isSafeInteger(gatewayPid) || gatewayPid <= 0 || !artifactRoot))
) {
  throw new Error("Expected Gateway port and optional Gateway PID and artifact root");
}

function captureOsState(phase) {
  if (!artifactRoot) {
    return;
  }
  let output = "Gateway OS diagnostics unavailable on this platform.\n";
  if (process.platform === "linux") {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../../lib/vitest-fork-os-observer.mjs", import.meta.url)),
        String(gatewayPid),
      ],
      { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
    );
    output =
      !result.error && result.status === 0 && result.stdout
        ? result.stdout
        : "Gateway OS diagnostics unavailable; bounded observer did not complete.\n";
  }
  try {
    writeFileSync(path.join(artifactRoot, `gateway-startup-os-${phase}.log`), output, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    process.stderr.write("Gateway OS diagnostics could not be written.\n");
  }
}

captureOsState("before");
const probes = {};
for (const endpoint of ["/readyz", "/startupz", "/healthz"]) {
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
captureOsState("after");

// This observation follows a failed readiness wait; it cannot change that outcome.
process.stdout.write(`${JSON.stringify({ afterReadinessFailure: true, probes })}\n`);
