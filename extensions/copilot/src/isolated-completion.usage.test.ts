import { expect, it } from "vitest";
import { createCopilotIsolatedHarnessFixture } from "./isolated-completion.test-support.js";

it("preserves usage reported separately from an isolated assistant message", async () => {
  const fixture = createCopilotIsolatedHarnessFixture();
  fixture.session.sendAndWait.mockImplementation(async () => {
    fixture.emitUsage({
      model: "gpt-4.1",
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
    });
    fixture.emitUsage({ model: "gpt-4.1", inputTokens: 999, outputTokens: 999 }, "child-agent");
    return { type: "assistant.message", data: { content: "answer", messageId: "usage-answer" } };
  });
  try {
    const result = await fixture.complete();
    expect(result?.assistant.usage).toMatchObject({
      input: 100,
      output: 12,
      cacheRead: 40,
      cacheWrite: 5,
      totalTokens: 157,
    });
  } finally {
    await fixture.harness.dispose?.();
  }
});
