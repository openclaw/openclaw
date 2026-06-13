#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_FLY_ORG_SLUG = "sam-larson-851";
const DEFAULT_FLY_MACHINES_API = "https://api.machines.dev/v1";
const TENANT_APP_PREFIX = "rockielab-tenant-";
const WORKFLOW_FILE = "build-runtime-image.yml";
const DEFAULT_GHCR_PULL_USERNAME = "saml212";
const GHCR_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function isTransientRolloutCode(code) {
  return ["000", "520", "521", "522", "523", "524"].includes(String(code));
}

export function tenantIdsFromFlyApps(body, prefix = TENANT_APP_PREFIX) {
  const apps = Array.isArray(body) ? body : Array.isArray(body?.apps) ? body.apps : [];
  const tenantIds = new Set();
  for (const app of apps) {
    const name = typeof app?.name === "string" ? app.name : app?.app_name;
    if (typeof name !== "string" || !name.startsWith(prefix)) {
      continue;
    }
    const tenantId = name.slice(prefix.length);
    if (tenantId) {
      tenantIds.add(tenantId);
    }
  }
  return [...tenantIds].toSorted((left, right) => left.localeCompare(right));
}

export function adminRolloutRequestHeaders(adminToken) {
  return {
    "X-Admin-Token": adminToken,
    Accept: "application/json",
  };
}

export function adminRolloutPollRequestHeaders(adminToken) {
  return adminRolloutRequestHeaders(adminToken);
}

export function adminTenantFallbackRequestHeaders(adminToken) {
  return adminRolloutRequestHeaders(adminToken);
}

export function outcomeFromTenantAdminRolloutResponse(response) {
  const body = parseJson(response?.body);
  if (!response || !String(response.code).startsWith("2")) {
    return "failed";
  }
  if (body?.state === "aborted") {
    return "failed";
  }
  if (Array.isArray(body?.failed) && body.failed.length > 0) {
    return "failed";
  }
  if (Array.isArray(body?.updated) && body.updated.length > 0) {
    return "updated";
  }
  return "skipped";
}

function errorDetailsFromTenantAdminRolloutResponse(response) {
  const body = parseJson(response?.body);
  if (!response || !String(response.code).startsWith("2")) {
    return response?.body || response?.error || `HTTP ${response?.code ?? "000"}`;
  }
  if (body?.state === "aborted") {
    return body?.error || body?.reason || response.body;
  }
  if (Array.isArray(body?.failed) && body.failed.length > 0) {
    return body?.error_details || body.failed;
  }
  return response?.body || response?.error || "";
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function envInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name) {
  return process.env[name]?.trim() || "";
}

function artifactPaths(dir) {
  return {
    attemptsJsonl: path.join(dir, "attempts.jsonl"),
    finalResponseJson: path.join(dir, "final-response.json"),
    finalResponseTxt: path.join(dir, "final-response.txt"),
    summaryJson: path.join(dir, "rollout-summary.json"),
    summaryMd: path.join(dir, "rollout-summary.md"),
  };
}

async function request(method, url, { headers = {}, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    method,
    headers,
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.body = body;
  }
  try {
    const response = await fetch(url, init);
    return {
      code: String(response.status).padStart(3, "0"),
      body: await response.text(),
      error: "",
    };
  } catch (error) {
    return {
      code: "000",
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseGhcrImageRef(image) {
  if (!image.startsWith("ghcr.io/")) {
    return null;
  }
  const remainder = image.slice("ghcr.io/".length);
  const digestAt = remainder.lastIndexOf("@");
  if (digestAt > 0) {
    const repository = remainder.slice(0, digestAt);
    const reference = remainder.slice(digestAt + 1);
    return repository.includes("/") && reference ? { repository, reference } : null;
  }
  const lastSlash = remainder.lastIndexOf("/");
  const tagColon = remainder.lastIndexOf(":");
  if (lastSlash <= 0 || tagColon <= lastSlash) {
    return null;
  }
  const repository = remainder.slice(0, tagColon);
  const reference = remainder.slice(tagColon + 1);
  if (!repository.includes("/") || !reference) {
    return null;
  }
  return { repository, reference };
}

function ghcrTokenUrl(repository) {
  const params = new URLSearchParams({
    service: "ghcr.io",
    scope: `repository:${repository}:pull`,
  });
  return `https://ghcr.io/token?${params.toString()}`;
}

function ghcrManifestUrl(repository, reference) {
  return `https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(reference)}`;
}

function redactCredentialFields(value) {
  if (Array.isArray(value)) {
    return value.map(redactCredentialFields);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => [
        key,
        ["token", "access_token", "refresh_token"].includes(key)
          ? "<redacted>"
          : redactCredentialFields(fieldValue),
      ]),
    );
  }
  return value;
}

function safeGhcrTokenResponseBody(body, error) {
  const raw = body || error || "";
  const parsed = parseJson(raw);
  return parsed ? JSON.stringify(redactCredentialFields(parsed)) : raw;
}

export async function preflightGhcrImagePull({ image, username, token, timeoutMs, attempts = [] }) {
  const parsed = parseGhcrImageRef(image);
  if (!parsed) {
    return {
      ok: true,
      skipped: true,
      repository: "",
      reference: "",
      auth_mode: "skipped-non-ghcr",
      code: "skipped",
      message: "Image is not a namespaced ghcr.io reference; GHCR preflight skipped.",
    };
  }

  const authMode = token ? "configured-token" : "anonymous";
  const tokenHeaders = {
    Accept: "application/json",
  };
  if (token) {
    const user = username || DEFAULT_GHCR_PULL_USERNAME;
    tokenHeaders.Authorization = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  }

  const tokenResponse = await request("GET", ghcrTokenUrl(parsed.repository), {
    timeoutMs,
    headers: tokenHeaders,
  });
  const tokenResponseBody = safeGhcrTokenResponseBody(tokenResponse.body, tokenResponse.error);
  await appendAttempt(attempts, {
    kind: "ghcr-pull-preflight-token",
    repository: parsed.repository,
    reference: parsed.reference,
    response_code: tokenResponse.code,
    auth_mode: authMode,
    retryable: false,
    response_body: tokenResponseBody,
  });

  const registryToken = parseJson(tokenResponse.body)?.token;
  if (tokenResponse.code !== "200" || !registryToken) {
    return {
      ok: false,
      repository: parsed.repository,
      reference: parsed.reference,
      auth_mode: authMode,
      code: tokenResponse.code,
      message: tokenResponseBody || `GHCR token request failed with HTTP ${tokenResponse.code}`,
    };
  }

  const manifestResponse = await request(
    "GET",
    ghcrManifestUrl(parsed.repository, parsed.reference),
    {
      timeoutMs,
      headers: {
        Accept: GHCR_MANIFEST_ACCEPT,
        Authorization: `Bearer ${registryToken}`,
      },
    },
  );
  await appendAttempt(attempts, {
    kind: "ghcr-pull-preflight-manifest",
    repository: parsed.repository,
    reference: parsed.reference,
    response_code: manifestResponse.code,
    auth_mode: authMode,
    retryable: false,
    response_body: manifestResponse.body || manifestResponse.error,
  });

  if (manifestResponse.code === "200") {
    return {
      ok: true,
      skipped: false,
      repository: parsed.repository,
      reference: parsed.reference,
      auth_mode: authMode,
      code: manifestResponse.code,
      message: "GHCR manifest is readable with the rollout credential.",
    };
  }

  const tokenHint = token
    ? "GHCR_PULL_TOKEN is set but cannot read this package."
    : "GHCR_PULL_TOKEN is not set and the package is not anonymously readable.";
  return {
    ok: false,
    repository: parsed.repository,
    reference: parsed.reference,
    auth_mode: authMode,
    code: manifestResponse.code,
    message: `${tokenHint} Manifest probe returned HTTP ${manifestResponse.code}: ${
      manifestResponse.body || manifestResponse.error || "<empty body>"
    }`,
  };
}

async function appendAttempt(attempts, entry) {
  attempts.push(entry);
}

export function rolloutOptionsFromEnv() {
  return {
    tenantId: optionalEnv("ROLLOUT_TENANT_ID"),
    canaryCount: optionalEnv("ROLLOUT_CANARY_COUNT"),
    canaryWaitSec: optionalEnv("ROLLOUT_CANARY_WAIT_SEC"),
    waveDelaySec: optionalEnv("ROLLOUT_WAVE_DELAY_SEC"),
    waveSize: optionalEnv("ROLLOUT_WAVE_SIZE"),
  };
}

export function hasScopedRolloutOptions(options) {
  return Boolean(
    options?.tenantId ||
    options?.canaryCount ||
    options?.canaryWaitSec ||
    options?.waveDelaySec ||
    options?.waveSize,
  );
}

export function expectedAcknowledgedRolloutOptions(options) {
  const expected = {};
  if (options.tenantId) {
    expected.tenant_id = options.tenantId;
  }
  if (options.canaryCount) {
    expected.canary_count = Number(options.canaryCount);
  }
  if (options.canaryWaitSec) {
    expected.canary_wait_sec = Number(options.canaryWaitSec);
  }
  if (options.waveDelaySec) {
    expected.wave_delay_sec = Number(options.waveDelaySec);
  }
  if (options.waveSize) {
    expected.wave_size = Number(options.waveSize);
  }
  return expected;
}

export function validateAcknowledgedRolloutOptions(options, responseJson) {
  const expected = expectedAcknowledgedRolloutOptions(options);
  const actual = responseJson?.rollout_options;
  const mismatches = [];
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      mismatches.push(`${key}: expected ${value}, got ${actual?.[key] ?? "<missing>"}`);
    }
  }
  return mismatches;
}

export function adminRolloutUrl(base, image, options = {}) {
  const params = new URLSearchParams({ image, confirm: "true" });
  if (options.tenantId) {
    params.set("tenant_id", options.tenantId);
  }
  if (options.canaryCount) {
    params.set("canary_count", options.canaryCount);
  }
  if (options.canaryWaitSec) {
    params.set("canary_wait_sec", options.canaryWaitSec);
  }
  if (options.waveDelaySec) {
    params.set("wave_delay_sec", options.waveDelaySec);
  }
  if (options.waveSize) {
    params.set("wave_size", options.waveSize);
  }
  if (options.asyncMode === false) {
    params.set("async", "false");
  } else {
    // Default to async mode (#1061). The admin endpoint's sync path
    // blocks for canary_wait_sec + wave_delay_sec inside the request,
    // which exceeds Cloudflare's ~100s proxy window for any fleet of
    // more than 2 tenants. Async mode returns 202 with a rollout_id
    // immediately; this script polls until terminal.
    params.set("async", "true");
  }
  return `${base}/api/admin/tenants/rollout?${params.toString()}`;
}

export function adminRolloutPollUrl(base, rolloutId) {
  return `${base}/api/admin/tenants/rollout/${encodeURIComponent(rolloutId)}`;
}

export function adminTenantFallbackUrl(base, image, tenantId) {
  return adminRolloutUrl(base, image, {
    tenantId,
    canaryCount: "0",
    canaryWaitSec: "0",
    waveDelaySec: "0",
    asyncMode: false,
  });
}

/**
 * Poll the async rollout status endpoint until the job is terminal.
 *
 * Returns `{code, body, json}` matching the shape of the original
 * curlPost response so the caller can reuse the same response-handling
 * branch. On terminal `state === "done"` the `json.result` carries the
 * same per-tenant outcome the legacy synchronous endpoint returned.
 *
 * Cloudflare-safe: each poll request is a short GET, so the proxy
 * window is never exceeded. The synchronous path it replaces would
 * 524 for any non-trivial fleet (#1061).
 */
async function pollAsyncRollout({
  base,
  rolloutId,
  adminToken,
  attempts,
  pollIntervalMs = 5000,
  maxPolls = 360, // 30 minutes / 5s = 360 polls
  timeoutMs = 180000, // 180s per poll request; matches default ROLLOUT_CURL_MAX_TIME
}) {
  const url = adminRolloutPollUrl(base, rolloutId);
  for (let i = 0; i < maxPolls; i += 1) {
    const response = await request("GET", url, {
      timeoutMs,
      headers: adminRolloutPollRequestHeaders(adminToken),
    });
    const body = response.body || response.error || "";
    const json = parseJson(body);
    await appendAttempt(attempts, {
      attempt: `poll-${i + 1}`,
      response_code: response.code,
      response_body: body,
      retryable: response.code === "200" && json?.state === "running",
    });
    if (response.code === "404") {
      // Fast-fail: a 404 is non-transient. Either the API restarted
      // and lost its in-memory registry, or the rollout_id aged out.
      // No point retrying for 30 minutes — surface immediately.
      // Phase 5 reviewers A + C, #1061.
      return { code: response.code, body, json };
    }
    if (response.code !== "200") {
      // Transient poll failure — keep trying until maxPolls.
      if (i < maxPolls - 1) {
        await sleep(pollIntervalMs);
        continue;
      }
      return { code: response.code, body, json };
    }
    if (json?.state === "done" || json?.state === "errored") {
      return { code: response.code, body, json };
    }
    await sleep(pollIntervalMs);
  }
  return {
    code: "timeout",
    body: `async rollout did not reach terminal state in ${maxPolls} polls`,
    json: { state: "running", rollout_id: rolloutId },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTenantIdsFromFly({ flyToken, flyOrgSlug, flyApiBase, timeoutMs }) {
  const url = `${flyApiBase}/apps?org_slug=${encodeURIComponent(flyOrgSlug)}`;
  const response = await request("GET", url, {
    timeoutMs,
    headers: {
      Authorization: `Bearer ${flyToken}`,
      Accept: "application/json",
    },
  });
  if (response.code !== "200") {
    throw new Error(
      `Fly app listing returned HTTP ${response.code}: ${response.body || response.error}`,
    );
  }
  return tenantIdsFromFlyApps(parseJson(response.body));
}

async function detectSuperseded() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const runNumber = Number.parseInt(process.env.GITHUB_RUN_NUMBER || "", 10);
  if (!token || !repository || !Number.isFinite(runNumber)) {
    return null;
  }
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&per_page=20&exclude_pull_requests=true`;
  const response = await request("GET", url, {
    timeoutMs: 10_000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.code !== "200") {
    console.warn(`Could not check supersession: HTTP ${response.code}`);
    return null;
  }
  const body = parseJson(response.body);
  const newer = body?.workflow_runs?.find((run) => {
    return (
      Number.isFinite(run?.run_number) &&
      run.run_number > runNumber &&
      run.head_branch === "main" &&
      (run.status !== "completed" || run.conclusion === "success")
    );
  });
  if (!newer) {
    return null;
  }
  return {
    id: newer.id,
    run_number: newer.run_number,
    status: newer.status,
    conclusion: newer.conclusion,
    head_sha: newer.head_sha,
    html_url: newer.html_url,
  };
}

async function rollTenantDirectly({ base, tenantId, image, adminToken, timeoutMs, attempts }) {
  const response = await request("POST", adminTenantFallbackUrl(base, image, tenantId), {
    timeoutMs,
    headers: adminTenantFallbackRequestHeaders(adminToken),
  });
  const outcome = outcomeFromTenantAdminRolloutResponse(response);
  await appendAttempt(attempts, {
    kind: "admin-tenant-rollout",
    tenant_id: tenantId,
    response_code: response.code,
    retryable: isTransientRolloutCode(response.code),
    response_body: response.body || response.error,
  });
  return {
    tenant_id: tenantId,
    response_code: response.code,
    outcome,
    response_body: response.body || response.error,
    error_detail: outcome === "failed" ? errorDetailsFromTenantAdminRolloutResponse(response) : "",
  };
}

async function runPerTenantFallback({
  base,
  image,
  adminToken,
  flyToken,
  flyOrgSlug,
  flyApiBase,
  timeoutMs,
  attempts,
}) {
  const tenantIds = await listTenantIdsFromFly({
    flyToken,
    flyOrgSlug,
    flyApiBase,
    timeoutMs,
  });
  const updated = [];
  const skipped = [];
  const failed = [];
  const errorDetails = {};
  const results = [];

  for (const tenantId of tenantIds) {
    const supersededBy = await detectSuperseded();
    if (supersededBy) {
      return {
        finalResult: "superseded-by-newer-build",
        supersededBy,
        tenantIds,
        results,
        updated,
        skipped,
        failed,
        errorDetails,
      };
    }

    const result = await rollTenantDirectly({
      base,
      tenantId,
      image,
      adminToken,
      timeoutMs,
      attempts,
    });
    results.push(result);
    if (result.outcome === "updated") {
      updated.push(tenantId);
    } else if (result.outcome === "skipped") {
      skipped.push(tenantId);
    } else {
      failed.push(tenantId);
      errorDetails[tenantId] = result.error_detail || result.response_body;
    }
  }

  return {
    finalResult:
      failed.length === 0 ? "succeeded-via-per-tenant-fallback" : "failed-per-tenant-fallback",
    supersededBy: null,
    tenantIds,
    results,
    updated,
    skipped,
    failed,
    errorDetails,
  };
}

function bucketCounts(updated, skipped, failed, total) {
  return {
    updated: updated.length,
    skipped: skipped.length,
    failed: failed.length,
    total,
  };
}

function renderMarkdown(summary) {
  const lines = [
    "## Cross-tenant rollout",
    "",
    `Image: \`${summary.image}\``,
    `Image SHA: \`${summary.image_sha}\``,
    "",
    `- duration: ${summary.duration_ms}ms`,
    `- scoped/manual rollout: ${summary.scoped_rollout ? "yes" : "no"}`,
    `- final result: ${summary.final_result}`,
    `- final response code: ${summary.final_response_code}`,
    `- response codes: ${summary.response_codes.join(",")}`,
    `- retries: ${summary.retry_count}`,
    "",
    `- updated: ${summary.buckets.updated}`,
    `- skipped (already on target): ${summary.buckets.skipped}`,
    `- failed: ${summary.buckets.failed}`,
    `- total tenants seen: ${summary.buckets.total}`,
  ];

  if (summary.superseded_by) {
    lines.push(
      "",
      "### Superseded",
      "",
      `Newer build-runtime-image run: ${summary.superseded_by.html_url}`,
      `Newer image SHA: \`${summary.superseded_by.head_sha}\``,
    );
  }

  if (summary.fallback) {
    lines.push(
      "",
      "### Per-tenant fallback",
      "",
      `Triggered by: ${summary.fallback.trigger}`,
      `Tenant source: ${summary.fallback.tenant_source}`,
      "Route: `/api/admin/tenants/rollout` with `tenant_id`, `confirm=true`, `async=false`, and zeroed canary/wave timing.",
    );
  }

  if (summary.scoped_rollout) {
    lines.push(
      "",
      "### Scoped rollout",
      "",
      "Per-tenant Fly fallback is disabled for scoped/manual rollouts so a canary or selected-tenant run cannot broaden to all tenants after an admin rollout transient.",
      `Options: \`${JSON.stringify(summary.rollout_options)}\``,
    );
  }

  if (summary.buckets.failed > 0 && summary.error_details) {
    lines.push("", "### Failures", "");
    for (const [tenantId, error] of Object.entries(summary.error_details)) {
      lines.push(`- \`${tenantId}\`: ${String(error).slice(0, 500)}`);
    }
  }

  if (summary.final_response_body) {
    lines.push("", "### Final response body", "", "```text", summary.final_response_body, "```");
  }

  return `${lines.join("\n")}\n`;
}

async function writeArtifacts(dir, summary, attempts) {
  await mkdir(dir, { recursive: true });
  const paths = artifactPaths(dir);
  const attemptsText = attempts.map((attempt) => JSON.stringify(attempt)).join("\n");
  await writeFile(paths.attemptsJsonl, attemptsText ? `${attemptsText}\n` : "");
  await writeFile(paths.finalResponseTxt, summary.final_response_body || "");
  if (summary.final_response_json) {
    await writeFile(
      paths.finalResponseJson,
      `${JSON.stringify(summary.final_response_json, null, 2)}\n`,
    );
  }
  const summaryForJson = { ...summary };
  delete summaryForJson.final_response_body;
  delete summaryForJson.final_response_json;
  await writeFile(paths.summaryJson, `${JSON.stringify(summaryForJson, null, 2)}\n`);
  await writeFile(paths.summaryMd, renderMarkdown(summary));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(summary), { flag: "a" });
  }
}

export async function runRollout() {
  const base = requireEnv("API_URL").replace(/\/+$/, "");
  const adminToken = requireEnv("ADMIN_TOKEN");
  const image = requireEnv("IMAGE_TAG");
  const artifactDir = process.env.ROLLOUT_ARTIFACT_DIR || ".artifacts/runtime-rollout";
  const maxAttempts = envInt("ROLLOUT_MAX_ATTEMPTS", 5);
  const fallbackAfterTransients = envInt("ROLLOUT_FALLBACK_AFTER_TRANSIENTS", 2);
  const timeoutMs = envInt("ROLLOUT_CURL_MAX_TIME", 180) * 1000;
  const flyToken = process.env.FLY_API_TOKEN?.trim();
  const flyOrgSlug = process.env.FLY_ORG_SLUG?.trim() || DEFAULT_FLY_ORG_SLUG;
  const flyApiBase = process.env.FLY_MACHINES_API?.trim() || DEFAULT_FLY_MACHINES_API;
  const ghcrPullUsername = process.env.GHCR_PULL_USERNAME?.trim() || DEFAULT_GHCR_PULL_USERNAME;
  const ghcrPullToken = process.env.GHCR_PULL_TOKEN?.trim() || "";
  const rolloutOptions = rolloutOptionsFromEnv();
  const scopedRollout = hasScopedRolloutOptions(rolloutOptions);
  const startedAtMs = Date.now();
  const attempts = [];
  const responseCodes = [];
  let retryCount = 0;
  let finalResult = "failed";
  let finalCode = "000";
  let finalBody = "";
  let finalJson = null;
  let fallback = null;
  let supersededBy = null;
  let updated = [];
  let skipped = [];
  let failed = [];
  let errorDetails = {};
  let ghcrPullPreflight = null;

  ghcrPullPreflight = await preflightGhcrImagePull({
    image,
    username: ghcrPullUsername,
    token: ghcrPullToken,
    timeoutMs,
    attempts,
  });
  if (!ghcrPullPreflight.ok) {
    finalResult = "failed-ghcr-pull-auth-preflight";
    finalCode = ghcrPullPreflight.code;
    finalBody = ghcrPullPreflight.message;
    errorDetails = {
      ghcr_pull_auth: ghcrPullPreflight.message,
      remediation:
        "Set GHCR_PULL_TOKEN on Rockielab/platform-runtime and Rockielab/platform-context to a read:packages PAT that can read this org package, or make the package public.",
    };
  } else {
    console.log(`POST ${adminRolloutUrl(base, image, rolloutOptions)}`);
  }

  for (let attempt = 1; ghcrPullPreflight.ok && attempt <= maxAttempts; attempt += 1) {
    const supersession = await detectSuperseded();
    if (supersession) {
      finalResult = "superseded-by-newer-build";
      supersededBy = supersession;
      break;
    }

    const response = await request("POST", adminRolloutUrl(base, image, rolloutOptions), {
      timeoutMs,
      headers: adminRolloutRequestHeaders(adminToken),
    });
    responseCodes.push(response.code);
    finalCode = response.code;
    finalBody = response.body || response.error;
    finalJson = parseJson(response.body);
    const retryable = isTransientRolloutCode(response.code);
    await appendAttempt(attempts, {
      kind: "admin-rollout",
      attempt,
      response_code: response.code,
      retryable,
      response_body: finalBody,
    });

    console.log(`admin rollout attempt ${attempt} response code: ${response.code}`);

    if (response.code.startsWith("2")) {
      // Async mode (#1061): the immediate 2xx carries
      // {state: "running", rollout_id, ...} — poll until terminal,
      // then drain the final result from the poll response. Skip
      // option-acknowledgement validation against the running
      // envelope (the acknowledged options live in the terminal
      // poll body, same shape as the legacy sync result).
      if (finalJson?.state === "running" && finalJson?.rollout_id) {
        const asyncRolloutId = finalJson.rollout_id;
        const polled = await pollAsyncRollout({
          base,
          rolloutId: asyncRolloutId,
          adminToken,
          attempts,
          timeoutMs,
        });
        finalCode = polled.code;
        finalBody = polled.body;
        finalJson = polled.json;
        responseCodes.push(polled.code);
        if (polled.code !== "200" || polled.json?.state !== "done") {
          finalResult = "failed-async-poll";
          if (polled.json?.error) {
            errorDetails = {
              async_rollout_id: asyncRolloutId,
              async_error: polled.json.error,
            };
          } else {
            // Surface the rollout_id even on transport-level failures
            // (404 from aged-out registry, poll timeout) so the
            // operator can grep server logs. Phase 5 reviewer C.
            errorDetails = { async_rollout_id: asyncRolloutId };
          }
          // When the async path craters mid-rollout (API restarted
          // and lost the in-memory registry → 404, or sustained CF
          // transient during polling), fall back to per-tenant Fly
          // updates if the operator has FLY_API_TOKEN configured.
          // This is the same fallback the synchronous transient
          // handler uses below — Phase 10 caught the gap when a
          // deploy-hetzner restarted the API mid-rollout (build
          // run 26811103950, #1061).
          if (flyToken && !scopedRollout) {
            console.warn(`async poll failed ${polled.code}; switching to per-tenant fallback`);
            let fallbackResult;
            try {
              fallbackResult = await runPerTenantFallback({
                base,
                image,
                adminToken,
                flyToken,
                flyOrgSlug,
                flyApiBase,
                timeoutMs,
                attempts,
              });
            } catch (err) {
              finalResult = "failed-per-tenant-fallback";
              errorDetails = {
                ...errorDetails,
                fallback_error: err?.message || String(err),
              };
              break;
            }
            finalResult = fallbackResult.finalResult;
            supersededBy = fallbackResult.supersededBy;
            fallback = {
              trigger: `async poll ${polled.code} after ${asyncRolloutId}`,
              tenant_source: `${flyApiBase}/apps?org_slug=${flyOrgSlug}`,
              tenant_ids: fallbackResult.tenantIds,
              results: fallbackResult.results,
            };
            updated = fallbackResult.updated;
            skipped = fallbackResult.skipped;
            failed = fallbackResult.failed;
            errorDetails = {
              ...errorDetails,
              ...fallbackResult.errorDetails,
            };
            if (failed.length > 0 && fallbackResult.results.length > 0) {
              finalBody = fallbackResult.results.at(-1)?.response_body || finalBody;
            }
          }
          break;
        }
        finalJson = polled.json.result || {};
        // Preserve the async rollout_id in the result so the rollout
        // summary artifact records it for forensic lookups in the
        // API logs (Phase 5 reviewer C, #1061). Underscore-prefixed
        // so it can't collide with a future server-side field.
        finalJson.async_rollout_id = asyncRolloutId;
        finalBody = JSON.stringify(finalJson);
      }
      const acknowledgementMismatches = scopedRollout
        ? validateAcknowledgedRolloutOptions(rolloutOptions, finalJson)
        : [];
      if (acknowledgementMismatches.length > 0) {
        finalResult = "failed-rollout-options-not-acknowledged";
        errorDetails = {
          rollout_options: acknowledgementMismatches.join("; "),
        };
        finalBody = [
          finalBody,
          "",
          `Scoped rollout options were not acknowledged: ${acknowledgementMismatches.join("; ")}`,
        ].join("\n");
        break;
      }
      finalResult = "succeeded";
      updated = Array.isArray(finalJson?.updated) ? finalJson.updated : [];
      skipped = Array.isArray(finalJson?.skipped) ? finalJson.skipped : [];
      failed = Array.isArray(finalJson?.failed) ? finalJson.failed : [];
      errorDetails = finalJson?.error_details || {};
      if (failed.length > 0) {
        finalResult = "failed-tenants";
      }
      break;
    }

    if (!retryable) {
      finalResult = "failed-non-retryable";
      break;
    }

    if (attempt >= fallbackAfterTransients && flyToken && !scopedRollout) {
      console.warn(
        `admin rollout returned transient HTTP ${response.code} ${attempt} time(s); switching to per-tenant fallback`,
      );
      let fallbackResult;
      try {
        fallbackResult = await runPerTenantFallback({
          base,
          image,
          adminToken,
          flyToken,
          flyOrgSlug,
          flyApiBase,
          timeoutMs,
          attempts,
        });
      } catch (error) {
        finalResult = "failed-per-tenant-fallback";
        const message = error instanceof Error ? error.message : String(error);
        errorDetails = { "tenant-enumeration": message };
        finalBody = message;
        break;
      }
      finalResult = fallbackResult.finalResult;
      supersededBy = fallbackResult.supersededBy;
      fallback = {
        strategy: "fly-app-list-plus-admin-tenant-rollout",
        trigger: `${attempt} transient admin rollout response(s)`,
        tenant_source: `${flyApiBase}/apps?org_slug=${flyOrgSlug}`,
        tenant_ids: fallbackResult.tenantIds,
        results: fallbackResult.results,
      };
      updated = fallbackResult.updated;
      skipped = fallbackResult.skipped;
      failed = fallbackResult.failed;
      errorDetails = fallbackResult.errorDetails;
      finalCode = fallbackResult.results.at(-1)?.response_code || response.code;
      finalBody = fallbackResult.results.at(-1)?.response_body || finalBody;
      finalJson = parseJson(finalBody);
      break;
    }

    if (attempt >= maxAttempts) {
      finalResult = "failed-after-retries";
      break;
    }

    retryCount += 1;
    const backoffSeconds = Math.min(60, 5 * 2 ** (attempt - 1));
    console.warn(`transient rollout error HTTP ${response.code}; retrying in ${backoffSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, backoffSeconds * 1000));
  }

  const total =
    fallback?.tenant_ids?.length ??
    finalJson?.summary?.total ??
    updated.length + skipped.length + failed.length;
  const summary = {
    image,
    image_sha: image.split(":").at(-1),
    duration_ms: Date.now() - startedAtMs,
    rollout_options: rolloutOptions,
    scoped_rollout: scopedRollout,
    response_codes: responseCodes,
    retry_count: retryCount,
    final_result: finalResult,
    final_response_code: finalCode,
    buckets: bucketCounts(updated, skipped, failed, total),
    attempts,
    fallback,
    superseded_by: supersededBy,
    error_details: errorDetails,
    ghcr_pull_preflight: ghcrPullPreflight,
    final_response_body: finalBody,
    final_response_json: finalJson,
  };

  await writeArtifacts(artifactDir, summary, attempts);

  if (finalResult === "superseded-by-newer-build") {
    console.log("Rollout superseded by a newer build-runtime-image run.");
    return 0;
  }
  if (!finalResult.startsWith("succeeded")) {
    console.error("Cross-tenant rollout did not succeed; see runtime-rollout-summary artifact.");
    return 1;
  }
  if (failed.length > 0) {
    console.warn("Some tenants failed to roll forward; see runtime-rollout-summary artifact.");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRollout()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
