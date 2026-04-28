import { describe, expect, it, vi } from "vitest";
import {
  createAttemptAbortable,
  getAttemptAbortReason,
  makeAttemptAbortError,
  makeAttemptTimeoutAbortReason,
  runEmbeddedAttemptPromptSubmission,
} from "./attempt-stream-loop.js";

describe("attempt stream loop helpers", () => {
  it("preserves abort reasons and timeout naming", () => {
    const timeout = makeAttemptTimeoutAbortReason();
    expect(timeout.name).toBe("TimeoutError");
    expect(timeout.message).toBe("request timed out");

    const controller = new AbortController();
    const reason = new Error("LLM idle timeout");
    controller.abort(reason);

    expect(getAttemptAbortReason(controller.signal)).toBe(reason);
    const abortError = makeAttemptAbortError(controller.signal);
    expect(abortError.name).toBe("AbortError");
    expect(abortError.message).toBe("LLM idle timeout");
    expect(abortError.cause).toBe(reason);
  });

  it("rejects abortable work when the run aborts", async () => {
    const controller = new AbortController();
    const abortable = createAttemptAbortable(controller);
    const pending = new Promise<string>(() => {});

    const result = abortable(pending);
    controller.abort("user_abort");

    await expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted",
      cause: "user_abort",
    });
  });

  it("submits runtime-only prompts without image or runtime-context side effects", async () => {
    const prompt = vi.fn(async () => undefined);
    const queueRuntimeContextForNextTurn = vi.fn(async () => undefined);

    await runEmbeddedAttemptPromptSubmission({
      abortable: async (promise) => await promise,
      applyRuntimeSystemPrompt: vi.fn(),
      buildRuntimeSystemPrompt: vi.fn(),
      images: [{ mimeType: "image/png" }],
      promptSubmission: {
        prompt: "runtime-only",
        runtimeOnly: true,
        runtimeContext: "context",
      },
      queueRuntimeContextForNextTurn,
      restoreSystemPrompt: vi.fn(),
      session: { prompt },
    });

    expect(prompt).toHaveBeenCalledWith("runtime-only");
    expect(queueRuntimeContextForNextTurn).not.toHaveBeenCalled();
  });

  it("wraps runtime context in a temporary system prompt and restores after prompt send", async () => {
    const events: string[] = [];
    const prompt = vi.fn(async () => {
      events.push("prompt");
    });

    await runEmbeddedAttemptPromptSubmission({
      abortable: async (promise) => await promise,
      applyRuntimeSystemPrompt: (systemPrompt) => {
        events.push(`apply:${systemPrompt}`);
      },
      buildRuntimeSystemPrompt: (runtimeContext) => `system:${runtimeContext}`,
      images: [{ mimeType: "image/png" }],
      promptSubmission: {
        prompt: "hello",
        runtimeContext: " runtime ctx ",
      },
      queueRuntimeContextForNextTurn: async (runtimeContext) => {
        events.push(`queue:${runtimeContext}`);
      },
      restoreSystemPrompt: () => {
        events.push("restore");
      },
      session: { prompt },
    });

    expect(prompt).toHaveBeenCalledWith("hello", {
      images: [{ mimeType: "image/png" }],
    });
    expect(events).toEqual(["apply:system:runtime ctx", "queue:runtime ctx", "prompt", "restore"]);
  });

  it("restores the original system prompt when prompt submission fails", async () => {
    const error = new Error("boom");
    const restoreSystemPrompt = vi.fn();

    await expect(
      runEmbeddedAttemptPromptSubmission({
        abortable: async (promise) => await promise,
        applyRuntimeSystemPrompt: vi.fn(),
        buildRuntimeSystemPrompt: () => "runtime-system",
        images: [],
        promptSubmission: {
          prompt: "hello",
          runtimeContext: "ctx",
        },
        queueRuntimeContextForNextTurn: async () => {},
        restoreSystemPrompt,
        session: {
          prompt: vi.fn(async () => {
            throw error;
          }),
        },
      }),
    ).rejects.toBe(error);

    expect(restoreSystemPrompt).toHaveBeenCalledTimes(1);
  });
});
