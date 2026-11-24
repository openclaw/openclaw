import fsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMessageEndContext,
  createMessageUpdateContext,
  endMessage,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";

const { appendRegularFile } = vi.hoisted(() => ({
  appendRegularFile: vi.fn(async () => undefined),
}));

vi.mock("../infra/fs-safe.js", () => ({ appendRegularFile }));

beforeEach(() => {
  appendRegularFile.mockClear();
  vi.stubEnv("OPENCLAW_RAW_STREAM", "1");
  vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", "/tmp/openclaw-synthetic-raw-stream.jsonl");
});
afterEach(() => vi.unstubAllEnvs());

describe("Incognito raw-stream diagnostic boundary", () => {
  it.each([false, true])(
    "keeps all stream content private without suppressing live delivery (Incognito: %s)",
    async (incognito) => {
      using mkdir = vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
      const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}synthetic`;
      for (const phase of ["commentary", "final_answer"] as const) {
        const message = {
          role: "assistant",
          phase,
          content: [{ type: "text", text: "synthetic private reply" }],
        };
        const onAgentEvent = vi.fn();
        const updateContext = createMessageUpdateContext({ onAgentEvent });
        updateContext.params.sessionKey = sessionKey;
        await updateMessage(updateContext, {
          message,
          assistantMessageEvent: { type: "text_delta", delta: "synthetic private reply" },
        });
        expect(onAgentEvent).toHaveBeenCalled();
        const endContext = createMessageEndContext({ onAgentEvent });
        endContext.params.sessionKey = sessionKey;
        await endMessage(endContext, { message });
      }
      const thinkingContext = createMessageUpdateContext();
      thinkingContext.params.sessionKey = sessionKey;
      await updateMessage(thinkingContext, {
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "synthetic private reasoning" }],
        },
        assistantMessageEvent: { type: "thinking_delta", delta: "synthetic private reasoning" },
      });
      expect(thinkingContext.emitReasoningStream).toHaveBeenCalled();
      // Raw diagnostics append after asynchronous directory creation, outside live delivery.
      await Promise.all(mkdir.mock.results.map((result) => result.value));
      expect(mkdir).toHaveBeenCalledTimes(incognito ? 0 : 5);
      expect(appendRegularFile).toHaveBeenCalledTimes(incognito ? 0 : 5);
    },
  );
});
