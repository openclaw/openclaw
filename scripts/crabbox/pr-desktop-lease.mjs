#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MINUTES = { linux: 90, mac: 60 };
const MAX_TTL_MINUTES = { linux: 100, mac: 100 };
const IDLE_TIMEOUT_MINUTES = 30;
const KEEPALIVE_POLL_MS = Number(process.env.CRABBOX_PR_DESKTOP_LEASE_KEEPALIVE_POLL_MS || "60000");
const WEBVNC_READY_TIMEOUT_MS = Number(
  process.env.CRABBOX_PR_DESKTOP_LEASE_WEBVNC_READY_TIMEOUT_MS || "60000",
);
const WEBVNC_READY_POLL_MS = Number(
  process.env.CRABBOX_PR_DESKTOP_LEASE_WEBVNC_READY_POLL_MS || "5000",
);
const TERMINAL_LEASE_STATES = new Set([
  "deleted",
  "expired",
  "failed",
  "not_found",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
]);
const TRUSTED_LEASE_COMMENT_AUTHORS = new Set(["github-actions[bot]"]);
const payload = readPayload();
const repo = required("target_repo");
const prNumber = Number(requiredAny(["item_number", "pr_number"]));
const action = normalizeAction(required("action"));
const platform = normalizePlatform(String(payload.platform || "linux"));
const provider = normalizeProvider(
  String(payload.provider || process.env.CRABBOX_PROVIDER || "aws"),
  platform,
);
const requestedHeadSha = String(
  payload.head_sha || process.env.CRABBOX_PR_DESKTOP_LEASE_HEAD_SHA || "",
);
const ttlMinutes = normalizeTtlMinutes(payload.ttl_minutes, platform);
const outputDir = path.join(".artifacts", "crabbox", "pr-desktop-lease");
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";

fs.mkdirSync(outputDir, { recursive: true });

await main();

async function main() {
  if (repo !== process.env.GITHUB_REPOSITORY) {
    postComment({
      status: "failed",
      failed_step: "target validation",
      failure_excerpt: `Crabbox PR desktop leases only support ${process.env.GITHUB_REPOSITORY}; received ${repo}.`,
    });
    return;
  }

  const pull = ghJson([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,headRefOid,url",
  ]);
  if (action === "lease" && String(pull.state || "").toUpperCase() !== "OPEN") {
    postComment({
      status: "failed",
      failed_step: "PR state check",
      failure_excerpt: `PR ${repo}#${prNumber} is ${pull.state || "unknown"}; desktop leases only run for open PRs.`,
    });
    return;
  }
  const headSha = String(pull.headRefOid || "");
  if (action === "lease" && requestedHeadSha && headSha && requestedHeadSha !== headSha) {
    postComment({
      status: "failed",
      failed_step: "head check",
      failure_excerpt: `PR head changed from ${requestedHeadSha} to ${headSha}. Re-run the command on the latest PR head.`,
    });
    return;
  }

  if (action === "lease") {
    await lease(headSha);
    return;
  }

  const active = findLatestActiveLease();
  if (!active?.lease_id) {
    postComment({
      status: "failed",
      failed_step: "state lookup",
      failure_excerpt: `No active Crabbox ${platform} desktop lease was found for ${repo}#${prNumber}.`,
    });
    return;
  }
  if (action === "status") {
    const activeProvider = active.provider || provider;
    if (active.inspection_error) {
      postComment({
        ...active,
        status: "failed",
        provider: activeProvider,
        failed_step: "state lookup",
        failure_excerpt: formatProcessFailure(
          ["crabbox", ...inspectArgs(active.lease_id, activeProvider)],
          active.inspection_error,
        ),
      });
      return;
    }
    const status = inspectLease(active.lease_id, activeProvider);
    if (status.status !== 0) {
      postComment({
        ...active,
        status: "failed",
        provider: activeProvider,
        failed_step: "status",
        failure_excerpt: formatProcessFailure(
          ["crabbox", ...inspectArgs(active.lease_id, activeProvider)],
          status,
        ),
      });
      return;
    }
    postComment({
      ...active,
      status: "already_active",
      provider: activeProvider,
      status_excerpt: status.stdout || status.stderr,
    });
    return;
  }
  if (action === "stop") {
    const activeProvider = active.provider || provider;
    if (active.inspection_error) {
      postComment({
        ...active,
        status: "failed",
        provider: activeProvider,
        failed_step: "state lookup",
        failure_excerpt: formatProcessFailure(
          ["crabbox", ...inspectArgs(active.lease_id, activeProvider)],
          active.inspection_error,
        ),
      });
      return;
    }
    const stop = runCrabbox(["stop", "--provider", activeProvider, active.lease_id], {
      allowFailure: true,
    });
    if (stop.status !== 0) {
      postComment({
        ...active,
        status: "failed",
        provider: activeProvider,
        failed_step: "stop",
        failure_excerpt: formatProcessFailure(
          ["crabbox", "stop", "--provider", activeProvider, active.lease_id],
          stop,
        ),
      });
      return;
    }
    postComment({ ...active, status: "stopped", provider: activeProvider });
    return;
  }
  const activeProvider = active.provider || provider;
  if (active.inspection_error) {
    postComment({
      ...active,
      status: "failed",
      provider: activeProvider,
      failed_step: "state lookup",
      failure_excerpt: formatProcessFailure(
        ["crabbox", ...inspectArgs(active.lease_id, activeProvider)],
        active.inspection_error,
      ),
    });
    return;
  }
  const reset = runCrabbox(
    [
      "webvnc",
      "reset",
      "--provider",
      activeProvider,
      "--target",
      targetForPlatform(platform),
      "--id",
      active.lease_id,
    ],
    {
      allowFailure: true,
    },
  );
  if (reset.status !== 0) {
    postComment({
      ...active,
      status: "failed",
      provider: activeProvider,
      failed_step: "reset-vnc",
      failure_excerpt: formatProcessFailure(
        [
          "crabbox",
          "webvnc",
          "reset",
          "--provider",
          activeProvider,
          "--target",
          targetForPlatform(platform),
          "--id",
          active.lease_id,
        ],
        reset,
      ),
    });
    return;
  }
  let ready = null;
  try {
    ready = await waitForWebvncReady(active.lease_id, activeProvider);
  } catch (error) {
    postComment({
      ...active,
      status: "failed",
      provider: activeProvider,
      failed_step: "reset-vnc-ready",
      failure_excerpt: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    });
    return;
  }
  const resetState = {
    ...active,
    status: "reset",
    provider: activeProvider,
    status_excerpt: ready.stdout || ready.stderr,
    webvnc_bridge: "reset",
  };
  postComment(resetState);
  await keepWorkflowAliveForLease(resetState);
}

async function lease(headSha) {
  const existing = findLatestActiveLease();
  if (existing?.lease_id) {
    const activeProvider = existing.provider || provider;
    if (existing.inspection_error) {
      postComment({
        ...existing,
        status: "failed",
        provider: activeProvider,
        failed_step: "existing-lease-inspect",
        failure_excerpt: [
          "Could not inspect the existing lease, so refusing to create a second shared desktop.",
          formatProcessFailure(
            ["crabbox", ...inspectArgs(existing.lease_id, activeProvider)],
            existing.inspection_error,
          ),
        ].join("\n\n"),
      });
      return;
    }
    if (leaseHeadMatches(headSha, existing.head_sha)) {
      try {
        const readyExisting = await ensureExistingWebvncBridge(existing, activeProvider);
        postComment({ ...readyExisting, status: "already_active", provider: activeProvider });
        if (readyExisting.keep_workflow_alive) await keepWorkflowAliveForLease(readyExisting);
      } catch (error) {
        postComment({
          ...existing,
          status: "failed",
          provider: activeProvider,
          failed_step: "reuse-webvnc",
          failure_excerpt: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        });
      }
      return;
    }
    const stop = runCrabbox(["stop", "--provider", activeProvider, existing.lease_id], {
      allowFailure: true,
    });
    if (stop.status !== 0) {
      postComment({
        ...existing,
        status: "failed",
        provider: activeProvider,
        failed_step: "replace-stale-lease-stop",
        failure_excerpt: formatProcessFailure(
          ["crabbox", "stop", "--provider", activeProvider, existing.lease_id],
          stop,
        ),
      });
      return;
    }
    postComment({ ...existing, status: "stopped", provider: activeProvider });
  }

  let leaseID = "";
  try {
    const acquiredAtMs = Date.now();
    const warmup = runCrabbox(warmupArgs());
    leaseID = extractLeaseID(warmup.stdout);
    if (!leaseID)
      throw new Error(`warmup did not print a cbx_ lease id\n\n${warmup.stdout || warmup.stderr}`);
    const baseState = {
      status: "creating",
      repo,
      pr_number: prNumber,
      platform,
      provider,
      lease_id: leaseID,
      slug: leaseSlug(),
      head_sha: headSha,
      ttl_minutes: ttlMinutes,
      idle_timeout_minutes: IDLE_TIMEOUT_MINUTES,
      created_at: new Date(acquiredAtMs).toISOString(),
      sharing: "org use",
    };
    writeSummary(baseState);
    runCrabbox([
      "run",
      "--provider",
      provider,
      "--target",
      targetForPlatform(platform),
      "--id",
      leaseID,
      "--fresh-pr",
      `${repo}#${prNumber}`,
      "--",
      "bash",
      "-lc",
      freshPrHeadCheckCommand(headSha),
    ]);
    runCrabbox(["share", "--id", leaseID, "--org"]);
    runCrabbox([
      "webvnc",
      "daemon",
      "start",
      "--provider",
      provider,
      "--target",
      targetForPlatform(platform),
      "--id",
      leaseID,
    ]);
    await waitForWebvncReady(leaseID, provider);
    const ready = {
      ...baseState,
      status: "ready",
      portal_url: portalURL(leaseID),
      expires_at: new Date(acquiredAtMs + ttlMinutes * 60_000).toISOString(),
    };
    writeSummary(ready);
    postComment(ready);
    await keepWorkflowAliveForLease(ready);
  } catch (error) {
    const failure = {
      status: "failed",
      repo,
      pr_number: prNumber,
      platform,
      provider,
      lease_id: leaseID || null,
      failed_step: leaseID ? "setup" : "warmup",
      failure_excerpt: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      portal_url: leaseID ? portalURL(leaseID) : null,
    };
    writeSummary(failure);
    postComment(failure);
  }
}

async function keepWorkflowAliveForLease(state) {
  if (process.env.GITHUB_ACTIONS !== "true" || !state.lease_id) return;
  const deadline = Date.now() + ttlMinutes * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(KEEPALIVE_POLL_MS, deadline - Date.now())),
    );
    if (Date.now() >= deadline) break;
    if (!isActiveInspection(inspectLease(state.lease_id, state.provider || provider))) return;
  }
}

async function ensureExistingWebvncBridge(existing, activeProvider) {
  const status = runCrabbox(webvncStatusArgs(existing.lease_id, activeProvider), {
    allowFailure: true,
  });
  if (isWebvncReady(status)) {
    return {
      ...existing,
      provider: activeProvider,
      webvnc_bridge: "connected",
      status_excerpt: status.stdout || status.stderr,
    };
  }
  runCrabbox([
    "webvnc",
    "daemon",
    "start",
    "--provider",
    activeProvider,
    "--target",
    targetForPlatform(platform),
    "--id",
    existing.lease_id,
  ]);
  const ready = await waitForWebvncReady(existing.lease_id, activeProvider);
  return {
    ...existing,
    provider: activeProvider,
    webvnc_bridge: "restarted",
    status_excerpt: ready.stdout || ready.stderr,
    keep_workflow_alive: true,
  };
}

async function waitForWebvncReady(leaseID, leaseProvider = provider) {
  const deadline = Date.now() + WEBVNC_READY_TIMEOUT_MS;
  let last = null;
  while (Date.now() <= deadline) {
    last = runCrabbox(webvncStatusArgs(leaseID, leaseProvider), { allowFailure: true });
    if (isWebvncReady(last)) return last;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WEBVNC_READY_POLL_MS, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error(
    [
      "crabbox webvnc status did not report portal bridge connected=true before timeout",
      "last status:",
      last ? trimOutput(last.stdout) : "<not checked>",
      "last stderr:",
      last ? trimOutput(last.stderr) : "<not checked>",
    ].join("\n"),
  );
}

function webvncStatusArgs(leaseID, leaseProvider = provider) {
  return [
    "webvnc",
    "status",
    "--provider",
    leaseProvider,
    "--target",
    targetForPlatform(platform),
    "--id",
    leaseID,
  ];
}

function warmupArgs() {
  const common = [
    "warmup",
    "--provider",
    provider,
    "--desktop",
    "--browser",
    "--ttl",
    `${ttlMinutes}m`,
    "--idle-timeout",
    `${IDLE_TIMEOUT_MINUTES}m`,
    "--slug",
    leaseSlug(),
  ];
  if (platform === "mac") return [...common, "--target", "macos", "--market", "on-demand"];
  return [...common, "--target", "linux"];
}

function postComment(state, options = {}) {
  const body = renderComment({
    repo,
    pr_number: prNumber,
    platform,
    provider,
    run_url: runUrl,
    ...state,
  });
  const bodyPath = path.join(outputDir, `comment-${Date.now()}.md`);
  fs.writeFileSync(bodyPath, body);
  const shouldUpsert = options.upsert ?? Boolean(state.lease_id);
  const existing = shouldUpsert ? findLatestTrustedLeaseComment() : null;
  if (existing?.id) {
    gh([
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/issues/comments/${existing.id}`,
      "-F",
      `body=@${bodyPath}`,
    ]);
    return;
  }
  gh(["api", `repos/${repo}/issues/${prNumber}/comments`, "-F", `body=@${bodyPath}`]);
}

function renderComment(state) {
  const status = String(state.status || "ready");
  const portal = state.portal_url || (state.lease_id ? portalURL(state.lease_id) : "");
  if (status === "ready") {
    return [
      marker(state),
      "🦞✅",
      "",
      "Crabbox desktop lease ready for PR testing.",
      "",
      summaryLines(state).join("\n"),
      "",
      `Portal: ${portal || "unavailable"}`,
      "WebVNC credentials are intentionally not posted in PR comments.",
      "",
      usefulCommands(state),
    ].join("\n");
  }
  if (status === "already_active") {
    return [
      marker(state),
      "🦞👀",
      "",
      `A Crabbox ${state.platform || "linux"} desktop lease is already active for this PR.`,
      "",
      summaryLines(state).join("\n"),
      "",
      `Portal: ${portal || "unavailable"}`,
      "WebVNC credentials are intentionally not posted in PR comments.",
      "",
      usefulCommands(state),
    ].join("\n");
  }
  if (status === "stopped") {
    return [
      marker(state),
      "🦞✅",
      "",
      `Stopped the Crabbox ${state.platform || "linux"} desktop lease for this PR.`,
      "",
      `- Lease: \`${state.lease_id || "unknown"}\``,
      `- Platform: \`${state.platform || "linux"}\``,
      `- Provider: \`${state.provider || "aws"}\``,
      state.lease_id ? `Portal: ${portalURL(state.lease_id)}` : null,
    ]
      .filter((line) => line !== null)
      .join("\n");
  }
  if (status === "reset") {
    return [
      marker(state),
      "🦞✅",
      "",
      `Reset WebVNC for the Crabbox ${state.platform || "linux"} desktop lease.`,
      "",
      summaryLines(state).join("\n"),
      "",
      `Portal: ${portal || "unavailable"}`,
      "WebVNC credentials are intentionally not posted in PR comments.",
    ].join("\n");
  }
  const failureIntro =
    state.failed_step === "replace-stale-lease-stop"
      ? `A stale Crabbox ${state.platform || "linux"} desktop lease is still active and could not be stopped before replacement.`
      : state.lease_id
        ? `Crabbox ${state.platform || "linux"} desktop lease is alive, but setup did not finish.`
        : `Crabbox ${state.platform || "linux"} desktop lease could not be created.`;
  return [
    marker(state),
    "🦞⚠️",
    "",
    failureIntro,
    "",
    `- Platform: \`${state.platform || "linux"}\``,
    `- Provider: \`${state.provider || "aws"}\``,
    state.lease_id ? `- Lease: \`${state.lease_id}\`` : null,
    `- Failed step: \`${state.failed_step || "unknown"}\``,
    `- Result: ${state.lease_id ? "lease kept for manual inspection" : "no lease was created"}`,
    portal ? "" : null,
    portal ? `Portal: ${portal}` : null,
    "",
    "Failure excerpt:",
    "```text",
    redactSensitiveText(state.failure_excerpt || "No failure excerpt captured.").slice(0, 2000),
    "```",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function summaryLines(state) {
  return [
    `- Platform: \`${state.platform || "linux"}\``,
    `- Provider: \`${state.provider || "aws"}\``,
    `- Lease: \`${state.lease_id || "unknown"}\``,
    state.slug ? `- Slug: \`${state.slug}\`` : null,
    state.expires_at ? `- Expires: \`${state.expires_at}\`` : null,
    `- Idle timeout: \`${state.idle_timeout_minutes || IDLE_TIMEOUT_MINUTES}m\``,
    state.head_sha
      ? `- PR code: \`${repo}#${prNumber}\` at \`${String(state.head_sha).slice(0, 12)}\``
      : null,
    state.sharing ? `- Sharing: \`${state.sharing}\`` : null,
    state.run_url ? `- Workflow: ${state.run_url}` : null,
  ].filter(Boolean);
}

function usefulCommands(state) {
  const lease = String(state.lease_id || "<lease>");
  const target = targetForPlatform(String(state.platform || "linux"));
  const currentProvider = String(state.provider || "aws");
  return [
    "Useful commands:",
    "```sh",
    `crabbox webvnc status --provider ${currentProvider} --target ${target} --id ${lease}`,
    `crabbox webvnc reset --provider ${currentProvider} --target ${target} --id ${lease} --open --take-control`,
    `crabbox ssh --provider ${currentProvider} --id ${lease}`,
    `crabbox stop --provider ${currentProvider} ${lease}`,
    "```",
  ].join("\n");
}

function findLatestLease() {
  const comment = findLatestTrustedLeaseComment();
  if (!comment) return null;
  const body = String(comment.body || "");
  const leaseID = extractLeaseIDFromCommentBody(body);
  return {
    lease_id: leaseID,
    platform,
    provider: body.match(/- Provider: `([^`]+)`/)?.[1] || provider,
    portal_url:
      body.match(/Portal: (https:\/\/\S+)/)?.[1] ||
      sanitizeWebvncURL(body.match(/WebVNC: (https:\/\/\S+)/)?.[1] || ""),
    expires_at: body.match(/- Expires: `([^`]+)`/)?.[1] || "",
    head_sha: body.match(/- PR code: `[^`]+` at `([0-9a-fA-F]{7,40})`/)?.[1] || "",
    status: body.includes("Stopped the Crabbox") ? "stopped" : "ready",
  };
}

function findLatestTrustedLeaseComment() {
  const comments = ghJson([
    "api",
    `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  const flattenedComments = Array.isArray(comments?.[0]) ? comments.flat() : comments;
  for (const comment of flattenedComments.reverse()) {
    if (!isTrustedLeaseComment(comment)) continue;
    const body = String(comment.body || "");
    if (!body.includes(marker({ repo, pr_number: prNumber, platform }))) continue;
    if (!extractLeaseIDFromCommentBody(body)) continue;
    return comment;
  }
  return null;
}

function findLatestActiveLease() {
  const latest = findLatestLease();
  if (!latest?.lease_id || latest.status === "stopped") return null;
  if (isExpiredCommentLease(latest)) return null;
  const inspect = inspectLease(latest.lease_id, latest.provider || provider);
  const activity = inspectionActivity(inspect);
  if (activity === "terminal") return null;
  return {
    ...latest,
    status_excerpt: inspect.stdout || inspect.stderr,
    inspection_error: activity === "unknown" ? inspect : null,
  };
}

function inspectLease(leaseID, leaseProvider = provider) {
  return runCrabbox(inspectArgs(leaseID, leaseProvider), { allowFailure: true });
}

function inspectArgs(leaseID, leaseProvider = provider) {
  return [
    "inspect",
    "--provider",
    leaseProvider,
    "--target",
    targetForPlatform(platform),
    "--id",
    leaseID,
    "--json",
  ];
}

function isExpiredCommentLease(lease) {
  if (!lease.expires_at) return false;
  const expiresAt = Date.parse(lease.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isActiveInspection(result) {
  return inspectionActivity(result) !== "terminal";
}

function inspectionActivity(result) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const state = normalizeLeaseState(
        parsed?.state ?? parsed?.State ?? parsed?.status ?? parsed?.Status,
      );
      if (state && TERMINAL_LEASE_STATES.has(state)) return "terminal";
      if (result.status === 0) return "active";
    } catch {
      // Human-readable inspect output is still useful for broad terminal-state matching.
    }
    if (
      /\b(stopped(?:[-_ ]with[-_ ]code)?|terminated|expired|deleted|not[-_ ]?found|released|404)\b/i.test(
        text,
      )
    ) {
      return "terminal";
    }
  }
  if (result.status !== 0) return "unknown";
  return "active";
}

function isWebvncReady(result) {
  if (result.status !== 0) return false;
  const text = `${result.stdout}\n${result.stderr}`;
  return /\bportal bridge:\s*connected=true\b/i.test(text);
}

function normalizeLeaseState(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
}

function leaseHeadMatches(currentHead, leasedHead) {
  const current = String(currentHead || "").toLowerCase();
  const leased = String(leasedHead || "").toLowerCase();
  if (!current || !leased) return false;
  return current.startsWith(leased) || leased.startsWith(current);
}

function runCrabbox(args, options = {}) {
  const result = spawnSync("crabbox", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(formatProcessFailure(["crabbox", ...args], result));
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ?? null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function formatProcessFailure(command, result) {
  return [
    `${command.join(" ")} failed`,
    `status: ${result.status ?? "null"}`,
    `signal: ${result.signal ?? "null"}`,
    result.error ? `error: ${result.error.name}: ${result.error.message}` : "error: null",
    "stdout:",
    trimOutput(result.stdout),
    "stderr:",
    trimOutput(result.stderr),
  ].join("\n");
}

function trimOutput(value) {
  const text = redactSensitiveText(value).trim();
  if (!text) return "<empty>";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...<truncated>` : text;
}

function gh(args) {
  execFileSync("gh", args, { stdio: "inherit" });
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function readPayload() {
  if (!process.env.GITHUB_EVENT_PATH)
    return Object.fromEntries(process.argv.slice(2).map((entry) => entry.split("=", 2)));
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  return event.client_payload || event.inputs || {};
}

function required(key) {
  const value = payload[key];
  if (!value) throw new Error(`missing payload.${key}`);
  return String(value);
}

function requiredAny(keys) {
  for (const key of keys) {
    if (payload[key]) return String(payload[key]);
  }
  throw new Error(`missing one of: ${keys.map((key) => `payload.${key}`).join(", ")}`);
}

function writeSummary(state) {
  fs.writeFileSync(
    path.join(outputDir, "pr-desktop-lease-summary.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}

function marker(state) {
  return `<!-- crabbox-pr-desktop-lease:${state.repo || repo}:${state.pr_number || prNumber}:${state.platform || platform} -->`;
}

function leaseSlug() {
  return `pr-${prNumber}-${platform}`;
}

function extractLeaseID(text) {
  return String(text || "").match(/\bcbx_[A-Za-z0-9_-]+\b/)?.[0] || "";
}

function extractLeaseIDFromCommentBody(body) {
  return body.match(/- Lease: `([^`]+)`/)?.[1] || body.match(/\bcbx_[A-Za-z0-9_-]+\b/)?.[0] || "";
}

function portalURL(leaseID) {
  return `${process.env.CRABBOX_COORDINATOR || "https://crabbox.openclaw.ai"}/portal/leases/${encodeURIComponent(leaseID)}`;
}

function targetForPlatform(value) {
  if (value === "mac") return "macos";
  return "linux";
}

function normalizeAction(value) {
  if (["lease", "status", "stop", "reset-vnc"].includes(value)) return value;
  throw new Error(`unsupported action: ${value}`);
}

function normalizePlatform(value) {
  if (["linux", "mac"].includes(value)) return value;
  if (value === "macos" || value === "darwin") return "mac";
  throw new Error(`unsupported platform: ${value}`);
}

function freshPrHeadCheckCommand(headSha) {
  if (!/^[0-9a-f]{40}$/i.test(headSha))
    throw new Error(`invalid PR head SHA from GitHub: ${headSha || "<empty>"}`);
  return [
    'actual="$(git rev-parse HEAD)"',
    `test "$actual" = "${headSha}" || { echo "fresh-pr checkout resolved $actual, expected ${headSha}" >&2; exit 1; }`,
  ].join(" && ");
}

function isTrustedLeaseComment(comment) {
  const login = String(comment?.user?.login || "");
  return TRUSTED_LEASE_COMMENT_AUTHORS.has(login);
}

function sanitizeWebvncURL(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    return url.toString();
  } catch {
    return text.replace(/#\S*$/u, "");
  }
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/(https:\/\/\S+\/portal\/leases\/\S+\/vnc)#\S*/gu, "$1")
    .replace(/([?&#]password=)[^\s&`)"']+/giu, "$1redacted")
    .replace(/(^|\n)(\s*password:\s*)[^\n\r`]+/giu, "$1$2redacted");
}

function normalizeProvider(value, normalizedPlatform) {
  const normalized = value.trim().toLowerCase();
  const allowedByPlatform = {
    linux: new Set(["aws", "azure", "hetzner"]),
    mac: new Set(["aws"]),
  };
  if (allowedByPlatform[normalizedPlatform]?.has(normalized)) return normalized;
  throw new Error(
    `unsupported provider/platform combination: provider=${value} platform=${normalizedPlatform}`,
  );
}

function normalizeTtlMinutes(value, normalizedPlatform) {
  const fallback = DEFAULT_TTL_MINUTES[normalizedPlatform];
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(raw) || raw < 15) {
    throw new Error(`ttl_minutes must be an integer of at least 15; received ${value}`);
  }
  const max = MAX_TTL_MINUTES[normalizedPlatform];
  if (raw > max) {
    throw new Error(
      `ttl_minutes must be at most ${max} for platform=${normalizedPlatform}; received ${value}`,
    );
  }
  return raw;
}
