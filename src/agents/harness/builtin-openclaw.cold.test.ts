import { expect, it, vi } from "vitest";

const loadEmbeddedAttempt = vi.hoisted(() => vi.fn());
const completeWithPreparedSimpleCompletionModel = vi.hoisted(() =>
  vi.fn(async () => ({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
  })),
);

// mock-isolation: Loading the real runner would erase the cold-import boundary under test.
vi.mock("../embedded-agent-runner/run/attempt.js", () => {
  loadEmbeddedAttempt();
  return { runEmbeddedAttempt: vi.fn() };
});
// mock-isolation: Observe the isolated handoff without dispatching a provider request.
vi.mock("../simple-completion-execution.js", () => ({ completeWithPreparedSimpleCompletionModel }));

import { createOpenClawAgentHarness } from "./builtin-openclaw.js";

it("runs isolated completion without loading the embedded agent runner", async () => {
  const params = {
    authorization: {
      owner: "host",
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      auth: { apiKey: "secret", source: "profile:test", mode: "api-key" },
    },
    config: {},
    systemPrompt: "system",
    prompt: "user",
    timeoutMs: 1_000,
    provider: "openai",
    modelId: "gpt-test",
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    outputTextPolicy: "strict-visible",
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof createOpenClawAgentHarness>["runIsolatedCompletionV2"]>
  >[0];

  await expect(createOpenClawAgentHarness().runIsolatedCompletionV2?.(params)).resolves.toEqual({
    assistant: expect.objectContaining({ stopReason: "stop" }),
  });
  expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
    expect.objectContaining({
      model: expect.objectContaining({ provider: "openai", id: "gpt-test" }),
      auth: expect.objectContaining({ apiKey: "secret", mode: "api-key" }),
      options: expect.objectContaining({ strictReasoningTags: true }),
      context: {
        systemPrompt: "system",
        messages: [expect.objectContaining({ role: "user", content: "user" })],
        tools: [],
      },
    }),
  );
  expect(loadEmbeddedAttempt).not.toHaveBeenCalled();
});
