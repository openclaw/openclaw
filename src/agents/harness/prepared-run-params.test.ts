import { describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeControlMessage,
  AgentRunEvent,
  PreparedAgentRun,
} from "../runtime-backend.js";
import { createRunParamsFromPreparedAgentRun } from "./prepared-run-params.js";

function createPreparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    runtimeId: "pi",
    runId: "run-rehydrate",
    agentId: "main",
    sessionId: "session-rehydrate",
    sessionKey: "agent:main:thread",
    sessionFile: "sqlite-transcript://main/session-rehydrate.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    provider: "openai",
    model: "gpt-5.5",
    timeoutMs: 1000,
    filesystemMode: "vfs-scratch",
    deliveryPolicy: { emitToolResult: true, emitToolOutput: false },
    runParams: {
      messageChannel: "slack",
      messageTo: "C123",
      toolsAllow: ["read"],
      prompt: "stale prompt should be replaced",
    },
    ...overrides,
  };
}

describe("createRunParamsFromPreparedAgentRun", () => {
  it("rehydrates high-level run params and keeps descriptor fields authoritative", () => {
    const events: AgentRunEvent[] = [];
    const abortController = new AbortController();
    const filesystem = { scratch: {} as never, artifacts: {} as never };
    const params = createRunParamsFromPreparedAgentRun(createPreparedRun(), {
      filesystem,
      signal: abortController.signal,
      emit: (event) => {
        events.push(event);
      },
    });

    expect(params).toMatchObject({
      runId: "run-rehydrate",
      sessionId: "session-rehydrate",
      sessionKey: "agent:main:thread",
      sessionFile: "sqlite-transcript://main/session-rehydrate.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 1000,
      messageChannel: "slack",
      messageTo: "C123",
      toolsAllow: ["read"],
    });
    expect(params.agentFilesystem).toBe(filesystem);
    expect(params.abortSignal).toBe(abortController.signal);
    expect(params.shouldEmitToolResult?.()).toBe(true);
    expect(params.shouldEmitToolOutput?.()).toBe(false);
    expect(events).toEqual([]);
  });

  it("emits parent callback events from worker-owned callbacks", async () => {
    const events: AgentRunEvent[] = [];
    const params = createRunParamsFromPreparedAgentRun(createPreparedRun(), {
      filesystem: { scratch: {} as never, artifacts: {} as never },
      emit: (event) => {
        events.push(event);
      },
    });

    params.onExecutionStarted?.();
    await params.onPartialReply?.({ text: "draft" });
    await params.onBlockReply?.({ text: "visible" });
    await params.onToolResult?.({ text: "tool" });
    await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });

    expect(events).toEqual([
      expect.objectContaining({
        stream: "lifecycle",
        data: { callback: "execution_started" },
      }),
      expect.objectContaining({
        stream: "final",
        data: { callback: "partial_reply", payload: { text: "draft" } },
      }),
      expect.objectContaining({
        stream: "final",
        data: { callback: "block_reply", payload: { text: "visible" } },
      }),
      expect.objectContaining({
        stream: "tool",
        data: { callback: "tool_result", payload: { text: "tool" } },
      }),
      expect.objectContaining({
        stream: "compaction",
        data: { callback: "agent_event", stream: "compaction", data: { phase: "start" } },
      }),
    ]);
  });

  it("mirrors worker hasRepliedRef mutations to the parent event bridge", () => {
    const events: AgentRunEvent[] = [];
    const params = createRunParamsFromPreparedAgentRun(
      createPreparedRun({
        deliveryPolicy: { emitToolResult: true, emitToolOutput: false, trackHasReplied: true },
      }),
      {
        filesystem: { scratch: {} as never, artifacts: {} as never },
        emit: (event) => {
          events.push(event);
        },
      },
    );

    expect(params.hasRepliedRef?.value).toBe(false);
    params.hasRepliedRef!.value = true;

    expect(params.hasRepliedRef?.value).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        stream: "lifecycle",
        data: { callback: "has_replied", value: true },
      }),
    ]);
  });

  it("bridges parent reply-operation control messages to the worker backend handle", async () => {
    let controlHandler: ((message: AgentRuntimeControlMessage) => void | Promise<void>) | undefined;
    const params = createRunParamsFromPreparedAgentRun(
      createPreparedRun({
        deliveryPolicy: {
          emitToolResult: true,
          emitToolOutput: false,
          bridgeReplyOperation: true,
        },
      }),
      {
        filesystem: { scratch: {} as never, artifacts: {} as never },
        emit: () => {},
        control: {
          onMessage(handler) {
            controlHandler = handler;
            return () => {
              controlHandler = undefined;
            };
          },
        },
      },
    );
    const queueMessage = vi.fn(async () => {});
    const cancel = vi.fn();
    const backend = {
      kind: "embedded",
      isStreaming: () => true,
      cancel,
      queueMessage,
    } as const;

    params.replyOperation?.attachBackend(backend);
    await controlHandler?.({ type: "queue_message", text: "keep going" });
    await controlHandler?.({ type: "cancel", reason: "user_abort" });
    params.replyOperation?.detachBackend(backend);

    expect(queueMessage).toHaveBeenCalledWith("keep going");
    expect(cancel).toHaveBeenCalledWith("user_abort");
    expect(controlHandler).toBeUndefined();
  });
});
