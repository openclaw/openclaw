import "./btw.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { ImageContent } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import type { PreparedAgentRunAdmission } from "./admitted-run-context.js";
import {
  DEFAULT_SESSION_KEY,
  createCliRuntimeConfig,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_QUESTION,
  mockDoneAnswer,
  mockCliOutput,
  registerCodexSideQuestionHarness,
  runSideQuestion,
  mockArg,
  expectRecordFields,
  streamSimpleMock,
  prepareCliRunContextMock,
  setupBtwTestHooks,
  prepareProviderRuntimeAuthMock,
  registerProviderStreamForModelMock,
  createDoneEvent,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
} from "./btw.test-support.js";
import type { StreamFn } from "./runtime/index.js";
const QUESTION_IMAGE: ImageContent = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  mimeType: "image/png",
};
describe("runBtwSideQuestion images", () => {
  setupBtwTestHooks();

  it("runBtwSideQuestion sends current images after question text with reasoning and tools off", async () => {
    mockDoneAnswer("A tiny dot.");
    await runSideQuestion({ images: [QUESTION_IMAGE], resolvedThinkLevel: "adaptive" });

    const context = expectRecordFields(mockArg(streamSimpleMock, 0, 1), {
      tools: undefined,
    });
    expect(context.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            { type: "text", text: expect.stringContaining(DEFAULT_QUESTION) },
            QUESTION_IMAGE,
          ],
        }),
      ]),
    );
    expectRecordFields(mockArg(streamSimpleMock, 0, 2), { reasoning: undefined });
  });

  it("runBtwSideQuestion passes current images to the Codex side-question hook", async () => {
    const hook = registerCodexSideQuestionHarness();
    await runSideQuestion({ images: [QUESTION_IMAGE] });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ images: [QUESTION_IMAGE] }));
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("reports omitted current images to CLI runtimes", async () => {
    mockCliOutput({ text: "CLI side answer." });
    await runSideQuestion({
      cfg: {
        agents: {
          defaults: {
            models: {
              [`${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`]: { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      images: [QUESTION_IMAGE, QUESTION_IMAGE],
    });
    const prepared = expectRecordFields(mockArg(prepareCliRunContextMock, 0, 0), {
      disableTools: true,
      images: undefined,
    });
    expect(prepared.prompt).toContain(
      "[2 attached image(s) omitted from CLI side-question input.]",
    );
  });
});

describe("side-question provider boundaries", () => {
  setupBtwTestHooks();

  it("preserves ordinary OpenAI BTW with provider-injected native web search", async () => {
    const payload = { input: [], tools: [{ type: "web_search" }] };
    const stream: StreamFn = async (model, _context, options) => {
      await options?.onPayload?.(payload, model);
      const output = createAssistantMessageEventStream();
      output.push(createDoneEvent("Search answer."));
      output.end();
      return output;
    };
    registerProviderStreamForModelMock.mockReturnValue(stream);

    await expect(runSideQuestion()).resolves.toEqual({ text: "Search answer." });
    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it.each(["openclaw", "codex"] as const)(
    "rejects withdrawn source access after %s preparation before dispatch",
    async (harness) => {
      let current = true;
      const hook = harness === "codex" ? registerCodexSideQuestionHarness() : undefined;
      prepareProviderRuntimeAuthMock.mockImplementation(async () => {
        current = false;
        return undefined;
      });
      // Harness auth prepares through this owner before the side-question hook.
      if (hook) {
        resolveModelAsyncMock.mockImplementation(async () => {
          current = false;
          return { model: resolveModelWithRegistryMock() };
        });
      }
      const assertCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("conversation access withdrawn");
        }
      });
      await expect(runSideQuestion({ toolCalls: "deny", assertCurrent })).rejects.toThrow(
        "conversation access withdrawn",
      );
      expect(streamSimpleMock).not.toHaveBeenCalled();
      if (hook) {
        expect(hook).not.toHaveBeenCalled();
      }
    },
  );
});

describe("runBtwSideQuestion CLI lifecycle", () => {
  setupBtwTestHooks();

  it("closes CLI side-question admission when backend cleanup rejects", async () => {
    const { cleanup } = mockCliOutput({ text: "CLI side answer." });
    const cleanupError = new Error("CLI cleanup failed");
    cleanup.mockRejectedValueOnce(cleanupError);

    await expect(
      runSideQuestion({
        cfg: createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).rejects.toBe(cleanupError);

    const { preparedRunAdmission } = mockArg(prepareCliRunContextMock, 0, 0) as {
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
