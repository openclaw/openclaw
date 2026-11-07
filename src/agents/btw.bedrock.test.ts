import { resolveProviderContext, type ProviderContext } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import * as btw from "./btw.test-support.js";

btw.setupBtwTestHooks();

it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
  btw.resolveModelWithRegistryMock.mockReturnValue({
    provider: "amazon-bedrock",
    id: "us.anthropic.claude-sonnet-4-5-v1:0",
    api: "anthropic-messages",
  });
  btw.getApiKeyForModelMock.mockResolvedValue({
    apiKey: undefined,
    mode: "aws-sdk",
    source: "aws-sdk default chain",
  });
  btw.streamSimpleMock.mockReturnValue(
    btw.makeAsyncEvents([btw.createDoneEvent("Bedrock answer.")]),
  );

  const result = await btw.runSideQuestion({
    cfg: {},
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-sonnet-4-5-v1:0",
  });

  expect(result).toEqual({ text: "Bedrock answer." });
  expect(btw.requireApiKeyMock).not.toHaveBeenCalled();
  const options = btw.streamSimpleMock.mock.calls.at(-1)?.[2];
  expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
});

it("merges unanswered Bedrock input with the side question before streaming", async () => {
  btw.resolveModelWithRegistryMock.mockReturnValue({
    provider: "amazon-bedrock",
    id: "us.anthropic.claude-sonnet-4-5-v1:0",
    api: "bedrock-converse-stream",
  });
  btw.mockActiveTranscript([
    btw.createUserTranscriptMessage([{ type: "text", text: "Unanswered orphan" }]),
    btw.createUserTranscriptMessage([{ type: "text", text: "New question" }]),
  ]);
  let providerContext: ProviderContext | undefined;
  btw.streamSimpleMock.mockImplementation(async (_model, context, options) => {
    providerContext = await resolveProviderContext(context, options);
    return btw.makeAsyncEvents([btw.createDoneEvent("Bedrock answer.")]);
  });
  await btw.runSideQuestion({ provider: "amazon-bedrock" });
  const messages = btw.contextMessages(providerContext);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: "user" });
  const content = JSON.stringify(messages[0]);
  expect(content).toContain("Unanswered orphan");
  expect(content).toContain("New question");
  expect(content).toContain(btw.DEFAULT_QUESTION);
});

it("keeps visible side-question context when a merged row has a saved model prompt", async () => {
  btw.resolveModelWithRegistryMock.mockReturnValue({
    provider: "amazon-bedrock",
    id: "us.anthropic.claude-sonnet-4-5-v1:0",
    api: "bedrock-converse-stream",
  });
  const stored = btw.createUserTranscriptMessage([{ type: "text", text: "Stored question" }]);
  const modelPromptProjection = { version: 1, text: "Saved main-turn prompt" };
  btw.mockActiveTranscript([{ ...stored, __openclaw: { modelPromptProjection } }]);
  btw.mockDoneAnswer("Bedrock answer.");
  await btw.runSideQuestion({ provider: "amazon-bedrock" });
  const content = JSON.stringify(btw.contextMessages(btw.streamContext()));
  expect(content).toContain("Stored question");
  expect(content).not.toContain("Saved main-turn prompt");
});
