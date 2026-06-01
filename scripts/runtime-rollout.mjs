#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_FLY_ORG_SLUG = "sam-larson-851";
const DEFAULT_FLY_MACHINES_API = "https://api.machines.dev/v1";
const TENANT_APP_PREFIX = "rockielab-tenant-";
const WORKFLOW_FILE = "build-runtime-image.yml";

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

export function tenantImageRequestBody(image) {
  return JSON.stringify({ image });
}

export function tenantImageRequestHeaders(apiPassword, adminToken, tenantDevToken = "") {
  const headers = {
    "X-Admin-Token": adminToken,
    Authorization: `Bearer ${apiPassword}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const trimmedTenantDevToken = tenantDevToken.trim();
  if (trimmedTenantDevToken) {
    headers["X-Tenant-Token"] = trimmedTenantDevToken;
  }
  return headers;
}

export function outcomeFromTenantImageResponse(response) {
  if (!response || response.code !== "200") {
    return "failed";
  }
  const body = parseJson(response.body);
  if (Array.isArray(body?.updated) && body.updated.length > 0) {
    return "updated";
  }
  return "skipped";
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
  const params = new URLSearchParams({ image });
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
  return `${base}/api/admin/tenants/rollout?${params.toString()}`;
}

function tenantImageUrl(base, tenantId) {
  return `${base}/api/tenants/${encodeURIComponent(tenantId)}/image`;
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

async function rollTenantDirectly({
  base,
  tenantId,
  image,
  apiPassword,
  adminToken,
  tenantDevToken,
  timeoutMs,
  attempts,
}) {
  const response = await request("POST", tenantImageUrl(base, tenantId), {
    timeoutMs,
    headers: tenantImageRequestHeaders(apiPassword, adminToken, tenantDevToken),
    body: tenantImageRequestBody(image),
  });
  const outcome = outcomeFromTenantImageResponse(response);
  await appendAttempt(attempts, {
    kind: "tenant-image",
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
  };
}

async function runPerTenantFallback({
  base,
  image,
  apiPassword,
  adminToken,
  tenantDevToken,
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
      apiPassword,
      adminToken,
      tenantDevToken,
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
      errorDetails[tenantId] = result.response_body;
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
      'Request body: `{ "image": "<target>" }` (no mode/binary fields, so subscription tenants keep their BINARY env).',
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
  const apiPassword = requireEnv("API_PASSWORD");
  const image = requireEnv("IMAGE_TAG");
  const artifactDir = process.env.ROLLOUT_ARTIFACT_DIR || ".artifacts/runtime-rollout";
  const maxAttempts = envInt("ROLLOUT_MAX_ATTEMPTS", 5);
  const fallbackAfterTransients = envInt("ROLLOUT_FALLBACK_AFTER_TRANSIENTS", 2);
  const timeoutMs = envInt("ROLLOUT_CURL_MAX_TIME", 180) * 1000;
  const flyToken = process.env.FLY_API_TOKEN?.trim();
  const tenantDevToken = process.env.ROCKIELAB_TENANT_DEV_TOKEN?.trim() || "";
  const flyOrgSlug = process.env.FLY_ORG_SLUG?.trim() || DEFAULT_FLY_ORG_SLUG;
  const flyApiBase = process.env.FLY_MACHINES_API?.trim() || DEFAULT_FLY_MACHINES_API;
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

  console.log(`POST ${adminRolloutUrl(base, image, rolloutOptions)}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const supersession = await detectSuperseded();
    if (supersession) {
      finalResult = "superseded-by-newer-build";
      supersededBy = supersession;
      break;
    }

    const response = await request("POST", adminRolloutUrl(base, image, rolloutOptions), {
      timeoutMs,
      headers: {
        "X-Admin-Token": adminToken,
        Authorization: `Bearer ${apiPassword}`,
        Accept: "application/json",
      },
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

    if (response.code === "200") {
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
          apiPassword,
          adminToken,
          tenantDevToken,
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
        strategy: "fly-app-list-plus-tenant-image-endpoint",
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
