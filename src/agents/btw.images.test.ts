import "./btw.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { ImageContent } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import type { PreparedAgentRunAdmission } from "./admitted-run-context.js";
import * as btw from "./btw.test-support.js";
import type { StreamFn } from "./runtime/index.js";
const QUESTION_IMAGE: ImageContent = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  mimeType: "image/png",
};
const cliParams = () => ({
  cfg: btw.createCliRuntimeConfig(),
  model: "claude-opus-4-7",
  sessionKey: btw.DEFAULT_SESSION_KEY,
});
describe("runBtwSideQuestion", () => {
  btw.setupBtwTestHooks();

  it("runBtwSideQuestion sends current images after question text with reasoning and tools off", async () => {
    btw.mockDoneAnswer("A tiny dot.");
    await btw.runSideQuestion({ images: [QUESTION_IMAGE], resolvedThinkLevel: "adaptive" });

    const context = btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 1), {
      tools: undefined,
    });
    expect(context.messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: expect.stringContaining(btw.DEFAULT_QUESTION) },
          QUESTION_IMAGE,
        ],
      }),
    );
    btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 2), { reasoning: undefined });
  });

  it("runBtwSideQuestion passes current images to the Codex side-question hook", async () => {
    const hook = btw.registerCodexSideQuestionHarness();
    await btw.runSideQuestion({ images: [QUESTION_IMAGE] });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ images: [QUESTION_IMAGE] }));
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
  });

  it("reports omitted current images to CLI runtimes", async () => {
    btw.mockCliOutput({ text: "CLI side answer." });
    await btw.runSideQuestion({
      ...cliParams(),
      images: [QUESTION_IMAGE, QUESTION_IMAGE],
    });
    const prepared = btw.expectRecordFields(btw.mockArg(btw.prepareCliRunContextMock, 0, 0), {
      disableTools: true,
      images: undefined,
    });
    expect(prepared.prompt).toContain(
      "[2 attached image(s) omitted from CLI side-question input.]",
    );
  });
  it("preserves ordinary OpenAI BTW with provider-injected native web search", async () => {
    const payload = { input: [], tools: [{ type: "web_search" }] };
    const stream: StreamFn = async (model, _context, options) => {
      await options?.onPayload?.(payload, model);
      const output = createAssistantMessageEventStream();
      output.push(btw.createDoneEvent("Search answer."));
      output.end();
      return output;
    };
    btw.registerProviderStreamForModelMock.mockReturnValue(stream);

    await expect(btw.runSideQuestion()).resolves.toEqual({ text: "Search answer." });
    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it.each(["openclaw", "codex"] as const)(
    "rejects withdrawn source access after %s preparation before dispatch",
    async (harness) => {
      let current = true;
      const hook = harness === "codex" ? btw.registerCodexSideQuestionHarness() : undefined;
      btw.prepareProviderRuntimeAuthMock.mockImplementation(async () => {
        current = false;
        return undefined;
      });
      if (hook) {
        btw.resolveModelAsyncMock.mockImplementation(async () => {
          current = false;
          return { model: btw.resolveModelWithRegistryMock() };
        });
      }
      const assertCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("conversation access withdrawn");
        }
      });
      await expect(btw.runSideQuestion({ toolCalls: "deny", assertCurrent })).rejects.toThrow(
        "conversation access withdrawn",
      );
      expect(btw.streamSimpleMock).not.toHaveBeenCalled();
      if (hook) {
        expect(hook).not.toHaveBeenCalled();
      }
    },
  );
  it("closes CLI side-question admission when backend cleanup rejects", async () => {
    const { cleanup } = btw.mockCliOutput({ text: "CLI side answer." });
    const cleanupError = new Error("CLI cleanup failed");
    cleanup.mockRejectedValueOnce(cleanupError);

    await expect(btw.runSideQuestion(cliParams())).rejects.toBe(cleanupError);

    const { preparedRunAdmission } = btw.mockArg(btw.prepareCliRunContextMock, 0, 0) as {
      preparedRunAdmission: PreparedAgentRunAdmission;
    };
    try {
      await expect(preparedRunAdmission.admit("embedded")).rejects.toThrow(
        "prepared execution context is already closed",
      );
    } finally {
      preparedRunAdmission.close();
    }
  });
});
