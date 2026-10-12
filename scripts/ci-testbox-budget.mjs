#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROFILES = {
  check: { runner: "blacksmith-16vcpu-ubuntu-2404", minutes: 240 },
  "check-memory": { runner: "blacksmith-32vcpu-ubuntu-2404", minutes: 240 },
  arm: { runner: "blacksmith-16vcpu-ubuntu-2404-arm", minutes: 120 },
  build: { runner: "blacksmith-16vcpu-ubuntu-2404", minutes: 35 },
  windows: { runner: "blacksmith-16vcpu-windows-2025", minutes: 75 },
};
const WINDOWS_RUNNERS = new Set([
  "blacksmith-8vcpu-windows-2025",
  "blacksmith-16vcpu-windows-2025",
]);
const ADMISSION_AGE_MS = 60 * 60_000;
const CONCURRENT_LEASES = 32;
const MAX_IDLE_MINUTES = 15;
const DEFAULT_STANDARD_MINUTES = 60;
const HIGH_MEMORY_LEASES = 4;

export function assertFreshTestboxAdmission(expiresAt, now = Date.now()) {
  const deadline = Number(expiresAt);
  if (!Number.isSafeInteger(deadline) || deadline <= now) {
    throw new Error(
      "Testbox admission expired after 60 minutes from dispatch; stop this lease and request a fresh one.",
    );
  }
}

/**
 * @param {{ profile: string, id: string, createdAt: string, runner?: string, minutes?: string | number }} request
 */
export function planTestboxAdmission(
  { profile, id, runner, minutes, createdAt },
  now = Date.now(),
) {
  const policy = PROFILES[profile];
  if (!policy || !/^tbx_[a-zA-Z0-9_-]+$/.test(id ?? "")) {
    throw new Error("Testbox admission requires a known profile and a tbx_ lease ID.");
  }
  const selectedRunner = runner || policy.runner;
  if (
    profile === "windows" ? !WINDOWS_RUNNERS.has(selectedRunner) : selectedRunner !== policy.runner
  ) {
    throw new Error(`Runner ${selectedRunner} is not allowed for the ${profile} Testbox profile.`);
  }
  const defaultMinutes = profile === "check" ? DEFAULT_STANDARD_MINUTES : policy.minutes;
  const timeout = minutes === undefined || minutes === "" ? defaultMinutes : Number(minutes);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > policy.minutes) {
    throw new Error(`Testbox runtime must be an integer from 1 to ${policy.minutes} minutes.`);
  }
  const created = Date.parse(createdAt);
  const expiresAt = created + ADMISSION_AGE_MS;
  if (!Number.isFinite(created) || created > now) {
    throw new Error("Testbox workflow creation time is invalid.");
  }
  assertFreshTestboxAdmission(expiresAt, now);
  // The shared finite namespace is enforced atomically by GitHub concurrency.
  // Do not include a workflow, branch, actor, or runner in this group name.
  // High-memory work shares four of the global slots, never a separate pool.
  const slots = profile === "check-memory" ? HIGH_MEMORY_LEASES : CONCURRENT_LEASES;
  const slot = createHash("sha256").update(id).digest().readUInt32BE(0) % slots;
  return {
    group: `openclaw-testbox-budget-v1-${slot}`,
    runner: selectedRunner,
    minutes: timeout,
    expires_at: expiresAt,
  };
}

export function boundedTestboxIdleMinutes(value) {
  const minutes = Number(value.trim());
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error("Testbox provider returned an invalid idle timeout.");
  }
  return Math.min(minutes, MAX_IDLE_MINUTES);
}

// Admission checks out only this script, so error handling must stay self-contained.
/** @param {Response} response */
async function githubAdmissionFailure(response) {
  const details = [];
  const requestId = response.headers.get("x-github-request-id");
  if (requestId && requestId.length <= 128 && /^[0-9a-f]+(?::[0-9a-f]+){3,5}$/i.test(requestId)) {
    details.push(`request_id=${requestId}`);
  }
  /** @type {Record<string, number>} */
  const numbers = {};
  for (const name of [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
    "x-ratelimit-reset",
    "retry-after",
  ]) {
    const value = response.headers.get(name);
    if (value && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))) {
      numbers[name] = Number(value);
      details.push(`${name}=${Number(value)}`);
    }
  }
  const resource = response.headers.get("x-ratelimit-resource");
  if (
    [
      "core",
      "search",
      "graphql",
      "integration_manifest",
      "code_search",
      "actions_runner_registration",
    ].includes(resource)
  ) {
    details.push(`x-ratelimit-resource=${resource}`);
  }

  // Never print response text or parser/stream errors: even an error can echo secrets.
  // The fetch signal retains the existing 15-second deadline while reading this body.
  let message;
  let body = "empty";
  const reader = response.body?.getReader();
  if (reader) {
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > 8192) {
          body = "too-large";
          break;
        }
        chunks.push(value);
      }
      if (body !== "too-large" && size > 0) {
        body = "invalid-json";
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        body = "json";
        if (parsed && typeof parsed.message === "string") {
          message = parsed.message;
        }
      }
    } catch {
      if (body !== "invalid-json") {
        body = "unreadable";
      }
    } finally {
      // Cancellation must not delay the diagnostic if the peer is still streaming.
      void reader.cancel().catch(() => undefined);
    }
  }

  const status = response.status;
  let classification = "http-error";
  if (status === 403 || status === 429) {
    if (numbers["x-ratelimit-remaining"] === 0) {
      classification = "primary-rate-limit";
    } else if (message?.startsWith("You have exceeded a secondary rate limit.")) {
      classification = "secondary-rate-limit";
    } else if (
      message === "Resource not accessible by integration" ||
      message === "Resource not accessible by personal access token"
    ) {
      classification = "resource-not-accessible";
    } else {
      classification = status === 429 ? "rate-limited" : "forbidden";
    }
  } else if (status === 401) {
    classification = "authentication-failed";
  } else if (status === 404) {
    classification = "not-found";
  } else if (status >= 500) {
    classification = "service-error";
  }
  details.unshift(`class=${classification}`, `body=${body}`);
  return `Cannot establish Testbox dispatch age: GitHub returned ${status} (${details.join("; ")}). Admission denied; use the request ID to investigate the GitHub response. Honor retry-after before a later request, and wait for x-ratelimit-reset when x-ratelimit-remaining=0; do not retry allocation in a loop.`;
}

async function main() {
  if (process.argv[2] === "configure") {
    // The workflow checks queue age before checkout; admitted work keeps its lease.
    const path = "/tmp/.testbox/idle_timeout";
    const idle = boundedTestboxIdleMinutes(readFileSync(path, "utf8"));
    writeFileSync(path, `${idle}\n`);
    console.log(
      `Testbox idle timeout capped at ${idle} minutes; active SSH work remains protected.`,
    );
    return;
  }
  if (process.argv[2] !== "admit") {
    throw new Error("Usage: node scripts/ci-testbox-budget.mjs admit|configure");
  }
  const response = await fetch(
    `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(await githubAdmissionFailure(response));
  }
  const run = await response.json();
  const plan = planTestboxAdmission({
    profile: process.env.TESTBOX_PROFILE,
    id: process.env.TESTBOX_ID,
    runner: process.env.TESTBOX_RUNNER,
    minutes: process.env.TESTBOX_MINUTES,
    createdAt: run.created_at,
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(plan)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.log(
    `Testbox ${plan.group}: ${plan.runner}, at most ${plan.minutes} minutes, idle ceiling ${MAX_IDLE_MINUTES} minutes.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
