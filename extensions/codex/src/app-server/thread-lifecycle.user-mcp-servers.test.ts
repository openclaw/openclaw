import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCodexAppServerBinding } from "./session-binding.js";
import { startOrResumeThread } from "./thread-lifecycle.js";

function threadStartResult(threadId = "thread-1"): Record<string, unknown> {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function threadResumeResult(threadId = "thread-existing"): Record<string, unknown> {
  return threadStartResult(threadId);
}

function createAppServerOptions() {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    sandbox: "workspace-write" as const,
  };
}

function createParams(
  sessionFile: string,
  workspaceDir: string,
  configOverrides?: EmbeddedRunAttemptParams["config"],
): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    config: configOverrides,
  } as EmbeddedRunAttemptParams;
}

describe("startOrResumeThread — user mcp.servers projection (regression: #80814)", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-80814-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects cfg.mcp.servers into the thread/start config patch under mcp_servers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            outlook: {
              transport: "stdio",
              command: "node",
              args: ["/opt/outlook-mcp/dist/index.js"],
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeDefined();
    expect(startParams!.config!.mcp_servers).toMatchObject({
      outlook: { command: "node", args: ["/opt/outlook-mcp/dist/index.js"] },
    });
  });

  it("omits mcp_servers from the start config when cfg has no user MCP servers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("projects cfg.mcp.servers into resumed-thread config too so re-attached threads see user MCP", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");

    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
    });

    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/resume") {
        return threadResumeResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: "node",
              args: ["/opt/notes-mcp/dist/index.js"],
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const resumeCall = request.mock.calls.find(([method]) => method === "thread/resume");
    const resumeParams = resumeCall?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(resumeParams?.config?.mcp_servers).toBeDefined();
    expect(resumeParams!.config!.mcp_servers).toMatchObject({
      notes: { command: "node", args: ["/opt/notes-mcp/dist/index.js"] },
    });
  });
});
