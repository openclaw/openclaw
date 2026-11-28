import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { buildGoogleProvider } from "../../../../extensions/google/api.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import {
  createActiveSession,
  createBoundaryInputDefaults,
} from "./attempt-session-boundary.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

it("keeps the Vertex request prefix through a tool round and the next turn", async () => {
  const model = makeProviderModelFixture({
    id: "gemini-3.1-pro-preview",
    provider: "google-vertex",
    api: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
  });
  const plugin = buildGoogleProvider();
  const context = { model, modelId: model.id, provider: model.provider };
  const { appendOnlyRuntimeContext } = resolveTranscriptPolicy({
    ...context,
    modelApi: model.api,
    runtimeHandle: { provider: model.provider, plugin },
  });
  const { activeSession } = createActiveSession();
  activeSession.agent.convertToLlm = convertToLlm;
  await prepareEmbeddedAttemptSessionBoundary({
    ...createBoundaryInputDefaults(),
    activeSession,
    appendOnlyRuntimeContext,
    attempt: { sessionId: "vertex-cache-prefix", prompt: "look up the value" },
    getUserTranscriptContexts: () => undefined,
  });

  const stream = expectDefined(plugin.createStreamFn?.(context), "Vertex stream");
  const captureContents = async (messages: AgentMessage[]) => {
    let contents: unknown[] | undefined;
    const response = await stream(
      model,
      { messages: await activeSession.agent.convertToLlm(messages) },
      {
        apiKey: "synthetic-vertex-key",
        onPayload(payload) {
          contents = (payload as { contents: unknown[] }).contents;
          throw new Error("Synthetic capture: do not send");
        },
      },
    );
    expect((await response.result()).errorMessage).toContain("Synthetic capture");
    return expectDefined(contents, "Vertex request contents");
  };
  const firstUser: AgentMessage = { role: "user", content: "look up the value", timestamp: 1 };
  const firstCarrier = buildRuntimeContextCustomMessage("first synthetic runtime context")!;
  const messages: AgentMessage[] = appendOnlyRuntimeContext
    ? [firstUser, firstCarrier]
    : [firstCarrier, firstUser];
  const first = await captureContents(messages);
  expect(JSON.stringify(first)).toContain("first synthetic runtime context");
  messages.push(
    makeAssistantMessageFixture({
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "toolCall", id: "call_lookup", name: "lookup", arguments: {} }],
      stopReason: "toolUse",
    }),
    {
      role: "toolResult",
      toolCallId: "call_lookup",
      toolName: "lookup",
      content: [{ type: "text", text: "value is 42" }],
      isError: false,
      timestamp: 2,
    },
  );
  const toolRound = await captureContents(messages);
  expect(toolRound.slice(0, first.length)).toEqual(first);
  expect(JSON.stringify(toolRound.slice(first.length))).toContain("value is 42");

  const nextUser: AgentMessage = { role: "user", content: "what next?", timestamp: 3 };
  const nextCarrier = buildRuntimeContextCustomMessage("next synthetic runtime context")!;
  messages.push(
    makeAssistantMessageFixture({
      content: [{ type: "text", text: "done" }],
    }),
    nextUser,
    nextCarrier,
  );
  const next = await captureContents(messages);
  expect(next.slice(0, toolRound.length)).toEqual(toolRound);
  expect(JSON.stringify(next.slice(toolRound.length))).toContain(
    "next synthetic runtime context",
  );
});
