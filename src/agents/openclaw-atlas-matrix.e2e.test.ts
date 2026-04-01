import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const atlasDir = "/Users/s1z0v/kd-projects/Homio/atlas";
const token = "openclaw-atlas-matrix-token";
const slots = ["ai01", "ai02", "ai03", "ai04", "ai05"] as const;
const spawnedChildren = new Set<ChildProcess>();

type MatrixTransport = "telegram-topic" | "bitrix";

type MatrixCase = {
  slot: (typeof slots)[number];
  transport: MatrixTransport;
  index: number;
  a2aTaskId: string;
  atlasTaskId: string;
  branch: string;
  title: string;
  summary: string;
  telegramChatId: string;
  telegramTopicId: string;
  bitrixTaskId: string;
  bitrixChatId: string;
};

function mkTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkTempDb() {
  return path.join(mkTempDir("openclaw-atlas-db-"), "mini-app.db");
}

function mkAutoenvStatePath() {
  const dir = mkTempDir("openclaw-atlas-autoenv-");
  const statePath = path.join(dir, "ai.json");
  const initialState = Object.fromEntries(slots.map((slot) => [slot, {}]));
  fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2), "utf-8");
  return statePath;
}

function createInspectRepoRoot() {
  const root = mkTempDir("openclaw-atlas-inspect-root-");
  const repoDir = path.join(root, "demo");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "src", "button.tsx"),
    'export const loginButtonLabel = "Sign in";\n',
    "utf-8",
  );
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "OpenClaw Matrix"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "openclaw-matrix@example.test"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  return { root, repoDir };
}

function spawnMiniApp(opts: {
  port: number;
  metricsPort: number;
  dbPath: string;
  autoenvStatePath: string;
  inspectRepoRoot: string;
}) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/mini-app/server.ts"], {
    cwd: atlasDir,
    env: {
      ...process.env,
      ATLAS_A2A_TOKEN: token,
      ATLAS_WEB_LOGS_TOKEN: token,
      ATLAS_WEB_DB_PATH: opts.dbPath,
      ATLAS_WEB_PORT: String(opts.port),
      ATLAS_WEB_METRICS_PORT: String(opts.metricsPort),
      ATLAS_AUTOENV_STATE: opts.autoenvStatePath,
      ATLAS_INSPECT_REPO_ROOT: opts.inspectRepoRoot,
      ATLAS_INSPECT_REPO_NAMESPACE: "homio",
    },
    stdio: "ignore",
  });
  spawnedChildren.add(child);
  return child;
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) {
    spawnedChildren.delete(child);
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  spawnedChildren.delete(child);
}

afterEach(async () => {
  for (const child of spawnedChildren) {
    await stopChild(child);
  }
});

async function waitForHealth(baseUrl: string, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`mini-app did not become healthy within ${timeoutMs}ms`);
}

async function api(
  baseUrl: string,
  pathname: string,
  init?: {
    method?: string;
    body?: Record<string, unknown> | null;
  },
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function expectOk<T = unknown>(
  baseUrl: string,
  pathname: string,
  init?: {
    method?: string;
    body?: Record<string, unknown> | null;
  },
) {
  const { response, payload } = await api(baseUrl, pathname, init);
  assert.equal(
    response.status,
    200,
    `${init?.method || "GET"} ${pathname} failed: ${JSON.stringify(payload)}`,
  );
  return payload as T;
}

function buildMatrixCase(
  slot: (typeof slots)[number],
  transport: MatrixTransport,
  index: number,
): MatrixCase {
  const suffix = `${transport === "telegram-topic" ? "tg" : "bx"}-${slot}`;
  return {
    slot,
    transport,
    index,
    a2aTaskId: `openclaw-a2a-${suffix}`,
    atlasTaskId: `openclaw-atlas-${suffix}`,
    branch: `feature/openclaw-matrix/${suffix}`,
    title: `OpenClaw ${transport} ${slot}`,
    summary: `OpenClaw local full contour ${transport} ${slot}`,
    telegramChatId: `-10091${100 + index}`,
    telegramTopicId: `${8100 + index}`,
    bitrixTaskId: `bitrix-${suffix}`,
    bitrixChatId: `chat-${suffix}`,
  };
}

function createAtlasToolsContext(taskCase: MatrixCase) {
  if (taskCase.transport === "telegram-topic") {
    return createOpenClawTools({
      agentChannel: "telegram",
      agentTo:
        taskCase.index % 2 === 0
          ? `telegram:${taskCase.telegramChatId}`
          : `telegram:group:${taskCase.telegramChatId}:topic:${taskCase.telegramTopicId}`,
      agentThreadId: taskCase.telegramTopicId,
    });
  }
  return createOpenClawTools({
    agentChannel: "bitrix",
    agentTo: `bitrix:${taskCase.bitrixChatId}`,
  });
}

async function publishLifecycleArtifacts(baseUrl: string, taskCase: MatrixCase, a2aTaskId: string) {
  const leasePayload = await expectOk<{ artifact?: { kind?: string } }>(
    baseUrl,
    `/api/a2a/tasks/${encodeURIComponent(a2aTaskId)}/artifacts`,
    {
      method: "POST",
      body: {
        kind: "WorkspaceLease",
        payload: {
          kind: "WorkspaceLease",
          workspaceId: `ws-${taskCase.slot}-${taskCase.a2aTaskId}`,
          taskId: a2aTaskId,
          slotId: taskCase.slot,
          branch: taskCase.branch,
          headSha: `facefeed${taskCase.index}`,
          accessMode: "read_only",
          transport: {
            kind: "workspace_projection",
            endpoint: `a2a+atlas://workspace/${taskCase.slot}/${taskCase.a2aTaskId}`,
          },
        },
      },
    },
  );
  assert.equal(leasePayload?.artifact?.kind, "WorkspaceLease");

  const previewPayload = await expectOk<{ artifact?: { kind?: string } }>(
    baseUrl,
    `/api/a2a/tasks/${encodeURIComponent(a2aTaskId)}/artifacts`,
    {
      method: "POST",
      body: {
        kind: "PreviewLink",
        payload: {
          kind: "PreviewLink",
          envName: taskCase.slot,
          branch: taskCase.branch,
          url: `https://${taskCase.slot}.example.test/openclaw/${taskCase.index}`,
        },
      },
    },
  );
  assert.equal(previewPayload?.artifact?.kind, "PreviewLink");

  const verifyPayload = await expectOk<{ artifact?: { kind?: string } }>(
    baseUrl,
    `/api/a2a/tasks/${encodeURIComponent(a2aTaskId)}/artifacts`,
    {
      method: "POST",
      body: {
        kind: "VerifyReport",
        payload: {
          kind: "VerifyReport",
          verifyKind: "ui",
          status: "passed",
          summary: {
            passed: 3,
            failed: 0,
            slot: taskCase.slot,
          },
          reviewUrls: [`https://review.example.test/${taskCase.a2aTaskId}`],
          primaryScreenshot: `.atlas/verifier/${taskCase.a2aTaskId}.png`,
        },
      },
    },
  );
  assert.equal(verifyPayload?.artifact?.kind, "VerifyReport");

  const mrPayload = await expectOk<{ artifact?: { kind?: string } }>(
    baseUrl,
    `/api/a2a/tasks/${encodeURIComponent(a2aTaskId)}/artifacts`,
    {
      method: "POST",
      body: {
        kind: "MergeRequestArtifact",
        payload: {
          kind: "MergeRequestArtifact",
          url: `https://gitlab.example.test/${taskCase.a2aTaskId}/merge_requests/${taskCase.index}`,
          iid: `${taskCase.index}`,
          title: `${taskCase.title} MR`,
        },
      },
    },
  );
  assert.equal(mrPayload?.artifact?.kind, "MergeRequestArtifact");
}

async function runMatrixTask(baseUrl: string, taskCase: MatrixCase) {
  if (taskCase.transport === "bitrix" && taskCase.index % 2 === 0) {
    const topicPayload = await expectOk<{ workThread?: { bitrixTaskId?: string } }>(
      baseUrl,
      "/api/runtime/telegram-topic",
      {
        method: "POST",
        body: {
          taskId: taskCase.atlasTaskId,
          branch: taskCase.branch,
          forumChatId: taskCase.telegramChatId,
          telegramTopicId: taskCase.telegramTopicId,
          bitrixTaskId: taskCase.bitrixTaskId,
          bitrixChatId: taskCase.bitrixChatId,
          title: taskCase.title,
          summary: taskCase.summary,
        },
      },
    );
    assert.equal(topicPayload?.workThread?.bitrixTaskId, taskCase.bitrixTaskId);
  }

  const previousBaseUrl = process.env.OPENCLAW_ATLAS_WEB_BASE_URL;
  const previousToken = process.env.OPENCLAW_ATLAS_A2A_TOKEN;
  process.env.OPENCLAW_ATLAS_WEB_BASE_URL = baseUrl;
  process.env.OPENCLAW_ATLAS_A2A_TOKEN = token;
  try {
    const tools = createAtlasToolsContext(taskCase);
    const inspectTool = tools.find((candidate) => candidate.name === "atlas_inspect");
    const executionTool = tools.find((candidate) => candidate.name === "atlas_execution");
    if (!inspectTool || !executionTool) {
      throw new Error("atlas tools are missing");
    }

    const contextResult = await inspectTool.execute(`inspect-context-${taskCase.index}`, {
      action: "context",
      repo: "homio/demo",
      ref: "HEAD",
    });
    const contextDetails = contextResult.details as { ok?: boolean; result?: { headSha?: string } };
    expect(contextDetails.ok).toBe(true);
    expect(String(contextDetails.result?.headSha || "")).toHaveLength(40);

    const fileResult = await inspectTool.execute(`inspect-file-${taskCase.index}`, {
      action: "file",
      repo: "homio/demo",
      ref: "HEAD",
      path: "src/button.tsx",
    });
    const fileDetails = fileResult.details as { ok?: boolean; result?: { content?: string } };
    expect(fileDetails.ok).toBe(true);
    expect(fileDetails.result?.content).toContain("Sign in");

    const submitArgs: Record<string, string> = {
      action: "submit",
      taskId: taskCase.a2aTaskId,
      atlasTaskId: taskCase.atlasTaskId,
      title: taskCase.title,
      summary: taskCase.summary,
      repo: "homio/demo",
      intent: "deploy_preview",
      branch: taskCase.branch,
      envName: taskCase.slot,
      brief: `Prepare preview for ${taskCase.title}.`,
      acceptanceCriteria: `Preview opens on ${taskCase.slot} and artifacts are published.`,
      verifyPlan: "Publish VerifyReport after preview bind.",
      stagePlan: "brief -> execute -> verify -> preview",
    };
    if (taskCase.transport === "bitrix") {
      submitArgs.bitrixTaskId = taskCase.bitrixTaskId;
    }

    const submitResult = await executionTool.execute(`submit-${taskCase.index}`, submitArgs);
    const submitDetails = submitResult.details as {
      ok?: boolean;
      result?: { task?: { id?: string }; workThread?: { id?: string | null } };
    };
    expect(submitDetails.ok).toBe(true);
    expect(
      submitDetails.result?.task?.id || (submitDetails.result as { id?: string } | undefined)?.id,
    ).toBe(taskCase.a2aTaskId);
    const workThreadId = String(submitDetails.result?.workThread?.id || "").trim() || null;
    expect(workThreadId).toBeTruthy();

    await expectOk(baseUrl, "/api/slots/lock", {
      method: "POST",
      body: {
        slot: taskCase.slot,
        taskId: taskCase.atlasTaskId,
        branch: taskCase.branch,
      },
    });

    const claimed = await expectOk<{ task?: { id?: string; claimToken?: string | null } }>(
      baseUrl,
      "/api/a2a/tasks/claim",
      {
        method: "POST",
        body: {
          claimedBy: "openclaw-matrix",
          sourceAgent: "openclaw",
          repo: "homio/demo",
        },
      },
    );
    assert.equal(claimed?.task?.id, taskCase.a2aTaskId);

    await expectOk(baseUrl, `/api/a2a/tasks/${encodeURIComponent(taskCase.a2aTaskId)}/status`, {
      method: "POST",
      body: {
        status: "running",
        claimToken: claimed?.task?.claimToken || null,
        metadata: {
          executor: {
            stage: "deploying_preview",
          },
          workThreadId,
        },
      },
    });

    await publishLifecycleArtifacts(baseUrl, taskCase, taskCase.a2aTaskId);

    await expectOk(baseUrl, `/api/a2a/tasks/${encodeURIComponent(taskCase.a2aTaskId)}/status`, {
      method: "POST",
      body: {
        status: "completed",
        metadata: {
          executor: {
            stage: "completed",
          },
          workThreadId,
        },
      },
    });

    const getResult = await executionTool.execute(`get-${taskCase.index}`, {
      action: "get",
      taskId: taskCase.a2aTaskId,
    });
    const getDetails = getResult.details as {
      ok?: boolean;
      result?: {
        task?: { atlasTaskId?: string | null; status?: string | null };
        latestArtifactByKind?: Record<string, { kind?: string }>;
        workThread?: { id?: string | null };
      };
    };
    expect(getDetails.ok).toBe(true);
    expect(getDetails.result?.task?.atlasTaskId).toBe(taskCase.atlasTaskId);
    expect(getDetails.result?.task?.status).toBe("completed");
    expect(getDetails.result?.latestArtifactByKind?.WorkspaceLease?.kind).toBe("WorkspaceLease");
    expect(getDetails.result?.latestArtifactByKind?.PreviewLink?.kind).toBe("PreviewLink");
    expect(getDetails.result?.latestArtifactByKind?.VerifyReport?.kind).toBe("VerifyReport");
    expect(getDetails.result?.latestArtifactByKind?.MergeRequestArtifact?.kind).toBe(
      "MergeRequestArtifact",
    );
    if (workThreadId) {
      expect(getDetails.result?.workThread?.id).toBe(workThreadId);
    }

    const eventsResult = await executionTool.execute(`events-${taskCase.index}`, {
      action: "events",
      taskId: taskCase.a2aTaskId,
      limit: 20,
    });
    const eventsDetails = eventsResult.details as {
      ok?: boolean;
      result?: { events?: Array<{ eventType?: string }> };
    };
    expect(eventsDetails.ok).toBe(true);
    expect(eventsDetails.result?.events?.some((event) => event.eventType === "task.created")).toBe(
      true,
    );
    expect(
      eventsDetails.result?.events?.some((event) => event.eventType === "artifact.published"),
    ).toBe(true);

    const artifactsResult = await executionTool.execute(`artifacts-${taskCase.index}`, {
      action: "artifacts",
      taskId: taskCase.a2aTaskId,
      limit: 20,
    });
    const artifactsDetails = artifactsResult.details as {
      ok?: boolean;
      result?: { artifacts?: Array<{ kind?: string }> };
    };
    expect(artifactsDetails.ok).toBe(true);
    expect(artifactsDetails.result?.artifacts?.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "WorkspaceLease",
        "PreviewLink",
        "VerifyReport",
        "MergeRequestArtifact",
      ]),
    );

    await expectOk(baseUrl, "/api/slots/unlock", {
      method: "POST",
      body: {
        slot: taskCase.slot,
        branch: taskCase.branch,
      },
    });

    return {
      slot: taskCase.slot,
      transport: taskCase.transport,
      a2aTaskId: taskCase.a2aTaskId,
      atlasTaskId: taskCase.atlasTaskId,
      workThreadId,
    };
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.OPENCLAW_ATLAS_WEB_BASE_URL;
    } else {
      process.env.OPENCLAW_ATLAS_WEB_BASE_URL = previousBaseUrl;
    }
    if (previousToken === undefined) {
      delete process.env.OPENCLAW_ATLAS_A2A_TOKEN;
    } else {
      process.env.OPENCLAW_ATLAS_A2A_TOKEN = previousToken;
    }
  }
}

describe("OpenClaw -> Atlas full contour matrix", () => {
  it("runs 10 local delivery tasks through atlas_inspect, atlas_execution, slots, and artifacts", async () => {
    const port = 26000 + Math.floor(Math.random() * 1000);
    const metricsPort = port + 1;
    const baseUrl = `http://127.0.0.1:${port}`;
    const dbPath = mkTempDb();
    const autoenvStatePath = mkAutoenvStatePath();
    const inspectRepo = createInspectRepoRoot();
    const child = spawnMiniApp({
      port,
      metricsPort,
      dbPath,
      autoenvStatePath,
      inspectRepoRoot: inspectRepo.root,
    });

    await waitForHealth(baseUrl);

    const previousBaseUrl = process.env.OPENCLAW_ATLAS_WEB_BASE_URL;
    const previousToken = process.env.OPENCLAW_ATLAS_A2A_TOKEN;
    try {
      const results: Array<{
        slot: string;
        transport: MatrixTransport;
        a2aTaskId: string;
        atlasTaskId: string;
        workThreadId: string | null;
      }> = [];

      let index = 1;
      for (const slot of slots) {
        for (const transport of ["telegram-topic", "bitrix"] as const) {
          const taskCase = buildMatrixCase(slot, transport, index++);
          results.push(await runMatrixTask(baseUrl, taskCase));
        }
      }

      expect(results).toHaveLength(10);
      expect(new Set(results.map((item) => item.a2aTaskId)).size).toBe(10);
      expect(new Set(results.map((item) => item.atlasTaskId)).size).toBe(10);

      const listTool = createOpenClawTools().find(
        (candidate) => candidate.name === "atlas_execution",
      );
      if (!listTool) {
        throw new Error("missing atlas_execution tool");
      }
      process.env.OPENCLAW_ATLAS_WEB_BASE_URL = baseUrl;
      process.env.OPENCLAW_ATLAS_A2A_TOKEN = token;
      const listResult = await listTool.execute("list-matrix", {
        action: "list",
        repo: "homio/demo",
        limit: 20,
      });
      const listDetails = listResult.details as {
        ok?: boolean;
        result?: { tasks?: Array<{ status?: string | null }> };
      };
      expect(listDetails.ok).toBe(true);
      expect(listDetails.result?.tasks).toHaveLength(10);
      expect(listDetails.result?.tasks?.filter((task) => task.status === "completed").length).toBe(
        10,
      );

      const slotsPayload = await expectOk<{
        slots: Array<{ status?: string | null }>;
      }>(baseUrl, "/api/slots");
      expect(slotsPayload?.slots).toHaveLength(slots.length);
      for (const slotRow of slotsPayload.slots) {
        expect(String(slotRow.status || "").trim()).toBe("free");
      }

      const autoenvState = JSON.parse(fs.readFileSync(autoenvStatePath, "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;
      for (const slot of slots) {
        expect(Object.keys(autoenvState[slot] || {})).toHaveLength(0);
      }
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.OPENCLAW_ATLAS_WEB_BASE_URL;
      } else {
        process.env.OPENCLAW_ATLAS_WEB_BASE_URL = previousBaseUrl;
      }
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_ATLAS_A2A_TOKEN;
      } else {
        process.env.OPENCLAW_ATLAS_A2A_TOKEN = previousToken;
      }
      await stopChild(child);
    }
  }, 120000);
});
