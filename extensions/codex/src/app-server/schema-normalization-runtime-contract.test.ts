import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  createParameterFreeTool,
  createPermissiveTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadStartResult as nativeThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import type { CodexThreadStartParams } from "./protocol.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import {
  createAppServerOptions as createBaseAppServerOptions,
  startOrResumeThreadWithEmptySkillCatalog as startOrResumeThreadImpl,
} from "./thread-lifecycle.test-fixtures.js";

let tempDir: string;
let bindingStore: ReturnType<typeof createCodexTestBindingStore>;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-1", serviceTier: string | null = null) {
  const result = nativeThreadStartResult(threadId, tempDir);
  return {
    ...result,
    thread: { ...result.thread, cliVersion: "0.149.0" },
    model: "gpt-5.4",
    serviceTier,
  };
}

function createRun(result = () => threadStartResult()) {
  const workspaceDir = path.join(tempDir, "workspace");
  const appServer = { ...createBaseAppServerOptions(), connectionClass: "local-loopback" as const };
  const request = vi.fn(async (method: string, _payload?: unknown) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/start") {
      return result();
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const start = (dynamicTools: Parameters<typeof startOrResumeThreadImpl>[0]["dynamicTools"]) =>
    startOrResumeThreadImpl({
      client: { request } as never,
      params: createParams(path.join(tempDir, "session.jsonl"), workspaceDir),
      cwd: workspaceDir,
      dynamicTools,
      appServer,
      bindingStore,
    });
  return { request, start, workspaceDir };
}

describe("Codex app-server dynamic tool schema boundary contract", () => {
  beforeEach(async () => {
    bindingStore = createCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-schema-contract-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("passes prepared executable dynamic tool schemas through canonical thread start specs", async () => {
    const { request, start, workspaceDir } = createRun();
    const parameterFreeTool = createParameterFreeTool("message");
    const dynamicTool = {
      type: "function" as const,
      name: parameterFreeTool.name,
      description: parameterFreeTool.description,
      inputSchema: normalizedParameterFreeSchema(),
    };
    await start([dynamicTool]);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
    const [startMethod, payload] =
      request.mock.calls.find(([method]) => method === "thread/start") ?? [];
    if (startMethod !== "thread/start") {
      throw new Error(`expected thread/start request, got ${startMethod}`);
    }
    const startPayload = payload as CodexThreadStartParams | undefined;
    expect(startPayload?.dynamicTools).toStrictEqual([
      {
        type: "function",
        name: dynamicTool.name,
        description: dynamicTool.description,
        inputSchema: dynamicTool.inputSchema,
      },
    ]);
    expect(startPayload).toMatchObject({
      cwd: workspaceDir,
      model: "gpt-5.4",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "OpenClaw",
      experimentalRawEvents: true,
    });
    expect(startPayload?.modelProvider).toBeUndefined();
    expect(typeof startPayload?.developerInstructions).toBe("string");
    expect(startPayload?.developerInstructions).toContain("OpenClaw");
  });

  it("accepts Codex app-server priority service tier responses", async () => {
    const { start } = createRun(() => threadStartResult("thread-priority", "priority"));
    const binding = await start([]);

    expect(binding.threadId).toBe("thread-priority");
  });

  it("treats dynamic tool schema changes as thread-fingerprint changes", async () => {
    let nextThreadId = 1;
    const { request, start } = createRun(() => threadStartResult(`thread-${nextThreadId++}`));

    await start([
      {
        type: "function",
        name: "message",
        description: "Permissive test tool",
        inputSchema: { type: "object" },
      },
    ]);
    const permissiveTool = createPermissiveTool("message");
    await start([
      {
        type: "function",
        name: permissiveTool.name,
        description: permissiveTool.description,
        inputSchema: permissiveTool.parameters,
      },
    ]);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
  });
});
