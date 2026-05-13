import { describe, expect, it, vi } from "vitest";
import type { AgentRunEvent, PreparedAgentRun } from "../runtime-backend.js";
import { createPiWorkerBackend } from "./pi-worker-backend.js";

function createPreparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    runtimeId: "pi",
    runId: "run-pi-worker",
    agentId: "main",
    sessionId: "session-pi-worker",
    sessionKey: "agent:main:thread",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    provider: "openai",
    model: "gpt-5.5",
    timeoutMs: 1000,
    filesystemMode: "vfs-scratch",
    deliveryPolicy: { emitToolResult: true, emitToolOutput: false },
    runParams: { messageChannel: "slack", messageTo: "C123" },
    ...overrides,
  };
}

describe("PI worker backend", () => {
  it("runs the embedded PI runner from a prepared descriptor", async () => {
    const runEmbeddedPiAgent = vi.fn(async (params) => {
      expect(params).toMatchObject({
        runId: "run-pi-worker",
        sessionId: "session-pi-worker",
        messageChannel: "slack",
        messageTo: "C123",
      });
      expect(params.shouldEmitToolResult?.()).toBe(true);
      return {
        payloads: [{ text: "done" }],
        meta: { durationMs: 12 },
      };
    });
    const backend = createPiWorkerBackend({ runEmbeddedPiAgent });

    await expect(
      backend.run(createPreparedRun(), {
        filesystem: { scratch: {} as never, artifacts: {} as never },
        emit: () => undefined,
      }),
    ).resolves.toEqual({
      ok: true,
      text: "done",
      data: {
        embeddedPiRunResult: {
          payloads: [{ text: "done" }],
          meta: { durationMs: 12 },
        },
      },
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
  });

  it("forwards worker callback events through the runtime context", async () => {
    const events: AgentRunEvent[] = [];
    const backend = createPiWorkerBackend({
      runEmbeddedPiAgent: vi.fn(async (params) => {
        await params.onBlockReply?.({ text: "visible" });
        return {
          payloads: [{ text: "final" }],
          meta: { durationMs: 12 },
        };
      }),
    });

    const result = await backend.run(createPreparedRun(), {
      filesystem: { scratch: {} as never, artifacts: {} as never },
      emit: (event) => {
        events.push(event);
      },
    });

    expect(result).toEqual({
      ok: true,
      text: "final",
      data: {
        embeddedPiRunResult: {
          payloads: [{ text: "final" }],
          meta: { durationMs: 12 },
        },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        stream: "final",
        data: { callback: "block_reply", payload: { text: "visible" } },
      }),
    ]);
  });
});
