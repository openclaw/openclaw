import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { AgentHarnessAttemptParams } from "./types.js";
import {
  createAgentHarnessWorkerLaunchRequest,
  createPiRunWorkerLaunchRequest,
} from "./worker-launch.js";

function createAttempt(
  overrides: Partial<AgentHarnessAttemptParams> = {},
): AgentHarnessAttemptParams {
  return {
    sessionId: "session-worker-launch",
    sessionKey: "agent:main:thread",
    sessionFile: "sqlite-transcript://main/session-worker-launch.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    runId: "run-worker-launch",
    provider: "openai",
    modelId: "gpt-5.5",
    thinkLevel: "medium",
    authStorage: undefined,
    authProfileStore: undefined,
    modelRegistry: undefined,
    model: undefined,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    ...overrides,
  } as AgentHarnessAttemptParams;
}

describe("agent harness worker launch request", () => {
  it("bundles the prepared run, parent signal, and permission profile", () => {
    const abortController = new AbortController();
    const request = createAgentHarnessWorkerLaunchRequest(
      createAttempt({ abortSignal: abortController.signal }),
      {
        runtimeId: "pi",
        filesystemMode: "vfs-only",
        permissionMode: "audit",
      },
    );

    expect(structuredClone(request.preparedRun)).toEqual(request.preparedRun);
    expect(request.preparedRun).toMatchObject({
      runtimeId: "pi",
      runId: "run-worker-launch",
      filesystemMode: "vfs-only",
      deliveryPolicy: { emitToolResult: true, emitToolOutput: false },
    });
    expect(request.signal).toBe(abortController.signal);
    expect(request.permissionProfile.mode).toBe("audit");
    expect(request.permissionProfile.fsRead).not.toContain("/tmp/workspace");
    expect(request.permissionProfile.fsWrite).not.toContain("/tmp/workspace");
  });

  it("uses the parent event bridge for worker events", async () => {
    const onBlockReply = vi.fn();
    const request = createAgentHarnessWorkerLaunchRequest(createAttempt({ onBlockReply }), {
      runtimeId: "pi",
    });

    await request.onEvent({
      runId: "run-worker-launch",
      stream: "final",
      data: { callback: "block_reply", payload: { text: "hello" } },
      sessionKey: "agent:main:thread",
    });

    expect(onBlockReply).toHaveBeenCalledWith({ text: "hello" });
  });
});

describe("PI run worker launch request", () => {
  it("builds a worker launch request before live attempt setup", async () => {
    const abortController = new AbortController();
    const onBlockReply = vi.fn();
    const request = createPiRunWorkerLaunchRequest(
      {
        sessionId: "session-pi-run",
        sessionKey: "agent:main:thread",
        sessionFile: "sqlite-transcript://main/session-pi-run.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        timeoutMs: 1000,
        runId: "run-pi-run",
        provider: "openai",
        model: "gpt-5.5",
        messageChannel: "slack",
        messageTo: "C123",
        abortSignal: abortController.signal,
        onBlockReply,
        shouldEmitToolResult: () => false,
        shouldEmitToolOutput: () => true,
      } as RunEmbeddedPiAgentParams,
      {
        runtimeId: "pi",
        filesystemMode: "vfs-scratch",
      },
    );

    expect(structuredClone(request.preparedRun)).toEqual(request.preparedRun);
    expect(request.signal).toBe(abortController.signal);
    expect(request.preparedRun).toMatchObject({
      runId: "run-pi-run",
      model: "gpt-5.5",
      deliveryPolicy: { emitToolResult: false, emitToolOutput: true },
      runParams: {
        messageChannel: "slack",
        messageTo: "C123",
      },
    });

    await request.onEvent({
      runId: "run-pi-run",
      stream: "final",
      data: { callback: "block_reply", payload: { text: "hello" } },
      sessionKey: "agent:main:thread",
    });

    expect(onBlockReply).toHaveBeenCalledWith({ text: "hello" });
  });
});
