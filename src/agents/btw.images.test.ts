import "./btw.mocks.test-support.js";
import { describe, expect, it } from "vitest";
import type { ImageContent } from "../llm/types.js";
import {
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
} from "./btw.test-support.js";
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

  it.each([0, 2])(
    "runBtwSideQuestion reports %i omitted current images to CLI runtimes",
    async (imageCount) => {
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
        images: imageCount ? Array.from({ length: imageCount }, () => QUESTION_IMAGE) : undefined,
      });

      const prepared = expectRecordFields(mockArg(prepareCliRunContextMock, 0, 0), {
        disableTools: true,
        images: undefined,
      });
      if (imageCount) {
        expect(prepared.prompt).toContain(
          `[${imageCount} attached image(s) omitted from CLI side-question input.]`,
        );
      } else {
        expect(prepared.prompt).not.toContain("omitted from CLI side-question input");
      }
    },
  );
});
