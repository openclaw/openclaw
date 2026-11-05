import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicModel,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamGoogleInteractions } from "./providers/google-interactions.js";
import { streamGoogle } from "./providers/google.js";
import { streamOpenAICodexResponses } from "./providers/openai-chatgpt-responses.js";
import { createJwt } from "./providers/openai-chatgpt-responses.test-helpers.js";
import { streamOpenAICompletions } from "./providers/openai-completions.js";
import { makeOpenAIProviderModel } from "./providers/openai-provider.test-support.js";
import { streamOpenAIResponses } from "./providers/openai-responses.js";
import { makeProviderModel } from "./providers/provider-model.test-support.js";
import { createAnthropicMessagesTransportStreamFn } from "./transports/anthropic-transport-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./transports/openai-completions-transport.js";
import { createOpenAIResponsesTransportStreamFn } from "./transports/openai-responses-client.js";
import type { StreamOptions } from "./types.js";

registerParityHostLifecycle();
const googleModel = makeProviderModel("google-generative-ai", "google", "gemini-3-pro");
const interactionsModel = makeProviderModel("google-interactions", "google", "gemini-3-flash");
const responsesModel = makeOpenAIProviderModel("openai-responses");
const completionsModel = makeOpenAIProviderModel("openai-completions");
const codexModel = makeProviderModel("openai-chatgpt-responses", "openai-codex", "gpt-5.5-codex");
const cases = [
  ["Anthropic SDK", (o: StreamOptions) => streamAnthropic(anthropicModel, context, o)],
  [
    "Anthropic fetch",
    (o: StreamOptions) => createAnthropicMessagesTransportStreamFn()(anthropicModel, context, o),
  ],
  [
    "Completions direct",
    (o: StreamOptions) => streamOpenAICompletions(completionsModel, context, o),
  ],
  [
    "Completions managed",
    (o: StreamOptions) => createOpenAICompletionsTransportStreamFn()(completionsModel, context, o),
  ],
  [
    "Google interactions",
    (o: StreamOptions) => streamGoogleInteractions(interactionsModel, context, o),
  ],
  ["Google generate content", (o: StreamOptions) => streamGoogle(googleModel, context, o)],
  ["Responses direct", (o: StreamOptions) => streamOpenAIResponses(responsesModel, context, o)],
  [
    "Responses managed",
    (o: StreamOptions) => createOpenAIResponsesTransportStreamFn()(responsesModel, context, o),
  ],
  [
    "Codex Responses",
    (o: StreamOptions) =>
      streamOpenAICodexResponses(codexModel, context, {
        ...o,
        apiKey: createJwt(),
        transport: "sse",
      }),
  ],
] as const;

describe.each(cases)("%s payload cancellation", (_name, stream) => {
  it.for(["resolve", "reject"] as const)(
    "retains a hook that will later %s",
    async (late, { signal }) => {
      const controller = new AbortController();
      const entered = createDeferred();
      const hook = createDeferred();
      const observed: Promise<unknown>[] = [];
      let hookFinished = false;
      const fetch = vi.fn(async () => new Response(null, { status: 500 }));
      configureAiTransportHost({
        ...getAiTransportHost(),
        buildModelFetch: () => fetch,
        observePendingProviderWork: (pending) => observed.push(pending),
      });
      const result = await stream({
        apiKey: "SYNTHETIC_FIXTURE_KEY",
        signal: controller.signal,
        onPayload: async () => {
          entered.resolve();
          try {
            await hook.promise;
          } finally {
            hookFinished = true;
          }
        },
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            result.result(),
            "Stream ended before payload hook",
          ),
          signal,
        );
        controller.abort(
          Object.assign(new Error("payload cancelled"), { code: "caller_cancelled" }),
        );
        const settled = await withinTest(result.result(), signal);
        expect(settled).toMatchObject({ stopReason: "aborted", errorCode: "caller_cancelled" });
        expect(hookFinished).toBe(false);
        expect(observed).not.toHaveLength(0);
        let drained = false;
        const draining = Promise.allSettled(observed).then(() => {
          drained = true;
        });
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        if (late === "resolve") {
          hook.resolve();
        } else {
          hook.reject(new Error("late payload failure"));
        }
        await draining;
        expect(hookFinished).toBe(true);
        expect(await result.result()).toBe(settled);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        hook.resolve();
        await Promise.allSettled([...observed, result.result()]);
      }
    },
  );
});
