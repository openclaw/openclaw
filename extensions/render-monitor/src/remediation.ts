import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  RenderMonitorConfigResolved,
  RenderMonitorServiceTarget,
  StoredRenderIncident,
} from "./types.js";
import {
  loadRenderMonitorState,
  saveRenderMonitorState,
  updateInvestigationProposal,
} from "./state-store.js";
import { RenderClient } from "./render-client.js";

const execFileAsync = promisify(execFile);

export type RenderRemediationApplyResult =
  | { ok: true; summary: string }
  | { ok: false; summary: string; error: string };

const proposalSchema = Type.Object({
  proposal: Type.Object({
    repo: Type.Object({
      repoPath: Type.String(),
      githubRepo: Type.String(),
      remote: Type.String(),
    }),
    git: Type.Object({
      baseBranch: Type.String(),
      deployBranch: Type.String(),
      newBranch: Type.String(),
    }),
    commit: Type.Object({
      message: Type.String(),
    }),
    patchUnifiedDiff: Type.String(),
  }),
  reasoning: Type.Optional(
    Type.Object({
      hypothesis: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String())),
      verification: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

function normalizeLines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function safeJsonExtract(text: string): string | null {
  const normalized = normalizeLines(text);
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return normalized.slice(start, end + 1);
}

function extractAssistantTextFromMessages(messages: unknown[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : undefined;
    if (role && role !== "assistant") continue;
    const content = record.content as unknown;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      const blockTexts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b && typeof b.type === "string" && b.type === "text" && typeof b.text === "string") {
          blockTexts.push(b.text);
        }
        // Some transcripts may use { text } without explicit "type".
        if (typeof b.text === "string") {
          blockTexts.push(b.text);
        }
      }
      if (blockTexts.length) {
        parts.push(blockTexts.join("\n"));
      }
    }
  }
  return parts.join("\n\n");
}

async function runGit(params: { cwd: string; timeoutMs?: number }, args: string[]): Promise<string> {
  const { cwd, timeoutMs } = params;
  const res = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  if (stderr.trim() && stdout.trim()) {
    return `${stdout}\n${stderr}`;
  }
  return (stdout || stderr || "").toString();
}

async function gitEnsureClean(params: { cwd: string }): Promise<void> {
  const out = await runGit({ cwd: params.cwd }, ["status", "--porcelain"]);
  if (out.trim()) {
    throw new Error(`git working tree not clean:\n${out.trim()}`);
  }
}

function parseGithubRepo(repo: string): { owner: string; name: string } {
  const trimmed = repo.trim();
  const m = trimmed.match(/^([^/]+)\/([^/]+)$/);
  if (!m) {
    throw new Error(`Invalid githubRepo (expected owner/name): ${repo}`);
  }
  return { owner: m[1], name: m[2] };
}

function isFailureConclusion(conclusion: string | null | undefined): boolean {
  if (!conclusion) return false;
  const c = conclusion.toLowerCase();
  return ["failure", "timed_out", "cancelled", "action_required"].some((needle) =>
    c.includes(needle),
  );
}

async function githubListCheckRuns(params: {
  owner: string;
  repo: string;
  sha: string;
  token: string;
}): Promise<Array<{ id: number; name?: string; status?: string; conclusion?: string | null }>> {
  const url = `https://api.github.com/repos/${params.owner}/${params.repo}/commits/${params.sha}/check-runs?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub check-runs request failed (${res.status})`);
  }
  const json = (await res.json()) as { check_runs?: Array<{ id: number; status?: string; conclusion?: string | null; name?: string }> };
  return (json.check_runs ?? []).slice(0, 200);
}

async function githubCommitStatus(params: {
  owner: string;
  repo: string;
  sha: string;
  token: string;
}): Promise<{ state?: string | null; description?: string | null }> {
  const url = `https://api.github.com/repos/${params.owner}/${params.repo}/commits/${params.sha}/status`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub commit status request failed (${res.status})`);
  }
  const json = (await res.json()) as { state?: string; description?: string };
  return { state: json.state ?? null, description: json.description ?? null };
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function resolveHealthOk(healthCheckState?: string | null): boolean {
  const s = (healthCheckState ?? "").toLowerCase().trim();
  if (!s) return true; // unknown -> don't block
  return !["failing", "failed", "unhealthy", "down", "error"].some((needle) => s.includes(needle));
}

function resolveDeployOk(status?: string | null): boolean {
  const s = (status ?? "").toLowerCase().trim();
  if (!s) return true;
  return !["failed", "errored", "cancelled", "canceled", "error"].some((needle) => s.includes(needle));
}

function extractRepoPathsFromUnifiedDiff(patch: string): string[] {
  const lines = normalizeLines(patch).split("\n");
  const paths: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // diff --git a/<path> b/<path>
      const m = line.match(/^diff --git\s+a\/(.+)\s+b\/(.+)$/);
      if (m?.[1]) paths.push(m[1]);
      if (m?.[2]) paths.push(m[2]);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      const cleaned = raw.replace(/^a\//, "").replace(/^b\//, "");
      paths.push(cleaned);
    }
    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      const cleaned = raw.replace(/^a\//, "").replace(/^b\//, "");
      paths.push(cleaned);
    }
  }
  return paths;
}

function validateNoPathTraversal(patch: string): void {
  const paths = extractRepoPathsFromUnifiedDiff(patch);
  for (const p of paths) {
    const normalized = p.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.includes("\0")) {
      throw new Error(`Patch contains absolute path: ${p}`);
    }
    if (normalized.split("/").some((seg) => seg === "..")) {
      throw new Error(`Patch contains path traversal: ${p}`);
    }
  }
}

export async function applyRenderRemediation(params: {
  api: OpenClawPluginApi;
  config: RenderMonitorConfigResolved;
  incident: StoredRenderIncident;
  service: RenderMonitorServiceTarget;
}): Promise<RenderRemediationApplyResult> {
  const { api, config, incident, service } = params;
  const telegramSend = api.runtime?.channel?.telegram?.sendMessageTelegram;
  const chatId = config.telegram.chatId;

  const send = async (text: string) => {
    if (!telegramSend || !chatId) return;
    await telegramSend(chatId, text, { silent: false, textMode: "markdown" });
  };

  if (!incident.lastInvestigation?.sessionKey || !incident.lastInvestigation?.runId) {
    return { ok: false, summary: "Missing investigation data", error: "Run /investigate first." };
  }
  if (!service.git) {
    return {
      ok: false,
      summary: `Service ${service.serviceId} has no git target configured`,
      error: "Add services[].git.repoPath + githubRepo in render-monitor config.",
    };
  }
  if (!incident.lastInvestigation.sessionKey) {
    return { ok: false, summary: "Missing sessionKey", error: "Investigation sessionKey not found." };
  }

  const investigationTimeoutMs =
    incident.lastInvestigation?.finishedAtMs != null ? 0 : config.remediations.investigationTimeoutMs;

  // Wait for the subagent to finish (so we can parse its JSON output).
  try {
    await api.runtime.subagent.waitForRun({
      runId: incident.lastInvestigation.runId,
      timeoutMs: investigationTimeoutMs > 0 ? investigationTimeoutMs : undefined,
    });
  } catch {
    // Keep going; session messages may still exist.
  }

  const sessionMessages = await api.runtime.subagent.getSessionMessages({
    sessionKey: incident.lastInvestigation.sessionKey,
    limit: 200,
  });

  const assistantText = extractAssistantTextFromMessages(sessionMessages.messages ?? []);
  const jsonRaw = safeJsonExtract(assistantText);
  if (!jsonRaw) {
    return {
      ok: false,
      summary: "Investigation output missing JSON",
      error: "Could not extract a JSON object from the investigator output.",
    };
  }

  let proposal: unknown;
  try {
    const parsed = JSON.parse(jsonRaw);
    proposal = parsed;
  } catch (err) {
    return {
      ok: false,
      summary: "Investigation JSON invalid",
      error: `JSON.parse failed: ${String((err as Error)?.message ?? err)}`,
    };
  }

  let validated: ReturnType<typeof proposalSchema["parse"]>;
  try {
    validated = proposalSchema.parse(proposal);
  } catch (err) {
    return {
      ok: false,
      summary: "Investigation proposal schema invalid",
      error: `Type validation failed: ${String((err as Error)?.message ?? err)}`,
    };
  }

  const proposalValue = validated.proposal;
  const patchUnifiedDiff = proposalValue.patchUnifiedDiff;
  if (!patchUnifiedDiff || !patchUnifiedDiff.trim()) {
    return { ok: false, summary: "Empty patch", error: "proposal.patchUnifiedDiff is empty." };
  }

  validateNoPathTraversal(patchUnifiedDiff);

  const githubToken =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.CI_GITHUB_TOKEN?.trim();
  if (!githubToken) {
    return {
      ok: false,
      summary: "Missing GitHub token",
      error: "Set GITHUB_TOKEN (or GH_TOKEN) for CI verification.",
    };
  }

  const { owner, name: repoName } = parseGithubRepo(proposalValue.repo.githubRepo);
  const effectiveRepoPath = (service.git.repoPath || proposalValue.repo.repoPath).trim();
  const effectiveRemote = (service.git.remote ?? proposalValue.repo.remote ?? "origin").trim();
  const baseBranch = (service.git.baseBranch ?? proposalValue.git.baseBranch).trim();
  const deployBranch = (service.git.deployBranch ?? proposalValue.git.deployBranch ?? baseBranch).trim();
  const newBranch = proposalValue.git.newBranch.trim();
  const commitMessage = proposalValue.commit.message.trim();

  await send(`🛠️ Applying remediation for incident ${incident.id} (branch: ${newBranch})…`);

  // Persist proposal cache so /logs and /status can show what was proposed.
  const stateRoot = api.runtime.state.resolveStateDir();
  let state = await loadRenderMonitorState(stateRoot);
  state = updateInvestigationProposal({
    state,
    incidentId: incident.id,
    proposal: validated,
    finishedAtMs: Date.now(),
  });
  await saveRenderMonitorState(stateRoot, state);

  // Git operations are executed on the host where OpenClaw is running.
  // SECURITY: apply only inside the configured repoPath and use argv-only git calls.
  const cwd = effectiveRepoPath;
  try {
    await gitEnsureClean({ cwd });
    // Ensure we start from base branch.
    await runGit({ cwd }, ["fetch", effectiveRemote]);
    await runGit({ cwd }, ["checkout", baseBranch]);
    // Create remediation branch.
    await runGit({ cwd }, ["checkout", "-b", newBranch]);

    // Write patch to a temp file outside the repo.
    const tmpDir = path.join(stateRoot, "plugins", "render-monitor", "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const patchPath = path.join(tmpDir, `patch-${incident.id}-${crypto.randomUUID()}.diff`);
    await fs.writeFile(patchPath, normalizeLines(patchUnifiedDiff), "utf8");

    await runGit(
      { cwd, timeoutMs: config.remediations.applyTimeoutMs },
      ["apply", "--whitespace=nowarn", patchPath],
    );

    const statusAfter = await runGit({ cwd }, ["status", "--porcelain"]);
    if (!statusAfter.trim()) {
      throw new Error("git apply produced no changes.");
    }

    await runGit({ cwd }, ["add", "-A"]);
    await runGit({ cwd }, ["commit", "-m", commitMessage]);

    const sha = (await runGit({ cwd }, ["rev-parse", "HEAD"])).trim();

    await send(`⬆️ Pushing commit ${sha.slice(0, 10)} to ${deployBranch}…`);
    if (deployBranch !== newBranch) {
      await runGit({ cwd }, ["push", effectiveRemote, `HEAD:${deployBranch}`]);
    } else {
      await runGit({ cwd }, ["push", effectiveRemote, newBranch]);
    }

    await send(`⏳ Waiting for CI checks on ${sha.slice(0, 10)}…`);

    const ciOk = await (async (): Promise<boolean> => {
      const deadline = Date.now() + config.remediations.ciVerifyTimeoutMs;
      while (Date.now() < deadline) {
        const runs = await githubListCheckRuns({
          owner,
          repo: repoName,
          sha,
          token: githubToken,
        }).catch(() => []);

        const anyInProgress = runs.some((r) => r.status && r.status.toLowerCase() !== "completed");
        const anyFailure = runs.some((r) => isFailureConclusion(r.conclusion));
        if (runs.length > 0 && !anyInProgress && !anyFailure) {
          return true;
        }
        // Fallback to commit status if check-runs are missing.
        if (runs.length === 0) {
          const status = await githubCommitStatus({
            owner,
            repo: repoName,
            sha,
            token: githubToken,
          }).catch(() => ({ state: null, description: null }));
          if (status.state === "success") {
            return true;
          }
        }

        await sleepMs(20_000);
      }
      return false;
    })();

    if (!ciOk) {
      await send(
        `❌ CI verification failed (timeout). Commit ${sha.slice(0, 10)} on ${owner}/${repoName}.`,
      );
      return { ok: false, summary: "CI verification failed", error: "GitHub checks did not reach success in time." };
    }

    await send(`✅ CI looks good. Verifying Render health for service ${service.serviceId}…`);
    const renderClient = new RenderClient({
      apiKey: config.renderApiKey,
      baseUrl: config.renderApiBaseUrl,
    });

    const renderOk = await (async (): Promise<boolean> => {
      const deadline = Date.now() + config.remediations.renderVerifyTimeoutMs;
      while (Date.now() < deadline) {
        const snap = await renderClient.getService(service.serviceId).catch(() => null);
        if (!snap) {
          await sleepMs(15_000);
          continue;
        }
        const healthOk = resolveHealthOk(snap.healthCheckState);
        const deployOk = resolveDeployOk(snap.latestDeploy?.status ?? null);
        if (healthOk && deployOk) {
          return true;
        }
        await sleepMs(20_000);
      }
      return false;
    })();

    if (!renderOk) {
      await send(`❌ Render health verification failed (timeout).`);
      return { ok: false, summary: "Render health failed", error: "Render did not become healthy in time." };
    }

    await send(`🎉 Remediation applied successfully. Incident ${incident.id} verified by CI + Render health.`);
    return { ok: true, summary: "CI + Render health verified" };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    await send(`❌ Remediation failed for incident ${incident.id}: ${msg.slice(0, 1000)}`);
    return { ok: false, summary: "Git remediation failed", error: msg };
  }
}

