import { expect, it, vi } from "vitest";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

const checkpointWork = vi.hoisted(() => ({ characters: 0 }));
vi.mock("../../packages/tool-call-repair/src/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/tool-call-repair/src/index.js")>();
  return {
    ...actual,
    projectPlainTextToolCallBlocks(
      text: string,
      options?: Parameters<typeof actual.projectPlainTextToolCallBlocks>[1],
    ) {
      checkpointWork.characters += text.length;
      return actual.projectPlainTextToolCallBlocks(text, options);
    },
  };
});

it("bounds list checkpoint work through the subscriber handler", async () => {
  const items = Array.from({ length: 420 }, (_, index) =>
    index % 2
      ? `- Step ${index}: run \`pnpm test\` and read [the guide](https://example.test/guide)\n  - Verify the result`
      : `- Step ${index} keeps the operator rollback path visible and the retry budget honest`,
  );
  const source = `\`\`\`json\n{"enabled":true}\n\`\`\`\n\n${items.join("\n")}\n`;
  // Match the coalesced chunk size measured in the contributor's Gateway trace.
  const chunk = 98;
  const ctx = createMessageUpdateContext();
  checkpointWork.characters = 0;
  for (let offset = 0; offset < source.length; offset += chunk) {
    await updateMessage(
      ctx,
      createOpenAiResponsesTextEvent({
        type: "text_delta",
        text: source.slice(0, offset + chunk),
        delta: source.slice(offset, offset + chunk),
        id: "msg-list",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
        messagePhase: "final_answer",
      }),
    );
  }
  expect(ctx.state.assistantStream?.text).toBe(source.trim());
  expect(checkpointWork.characters).toBeGreaterThan(0);
  expect(checkpointWork.characters).toBeLessThan(source.length * 64);
});
