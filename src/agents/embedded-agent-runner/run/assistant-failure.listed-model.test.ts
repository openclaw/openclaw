import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { buildKnownAgentRunFailureReplyPayload } from "../../../auto-reply/reply/agent-runner-failure-reply.js";
import type { ProviderCatalogOutcome } from "../../../plugins/provider-catalog-outcome.js";
import { FailoverError } from "../../failover-error.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { log } from "../logger.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { makeAssistantFailureInput } from "./assistant-failure.test-support.js";

vi.mock("../../../plugins/provider-failover.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-failover.js")>()),
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => null),
}));

const REJECTED_COPY =
  "The provider lists this model but rejected a chat request. It may not be a chat model, or it isn't enabled for this account. Choose another model.";
const MODEL = "fixture-listed-model";

// Live OpenAI and Google AI Studio bodies; model ids are synthetic, request ids and headers removed.
const MODEL_DOES_NOT_EXIST = {
  name: "OpenAI Responses 404 model does not exist",
  status: 404,
  body: `{"error":{"message":"The model \`${MODEL}\` does not exist or you do not have access to it.","type":"invalid_request_error","param":null,"code":"model_not_found"}}`,
};
const REJECTIONS = [
  MODEL_DOES_NOT_EXIST,
  {
    name: "OpenAI Chat Completions 403 not allowed to sample",
    status: 403,
    body: '{"error":{"message":"You are not allowed to sample from this model","type":"invalid_request_error","param":null,"code":null}}',
  },
  {
    name: "OpenAI Responses 400 not supported with the Responses API",
    status: 400,
    body: `{"error":{"message":"The requested model '${MODEL}' is not supported with the Responses API.","type":"invalid_request_error","param":"model","code":"model_not_found"}}`,
  },
  {
    name: "Google generateContent 404 not supported for generateContent",
    provider: "google",
    status: 404,
    body: `{"error":{"code":404,"message":"models/${MODEL} is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.","status":"NOT_FOUND"}}`,
  },
  {
    name: "Google generateContent 400 response modalities",
    provider: "google",
    status: 400,
    body: `{"error":{"code":400,"message":"The requested combination of response modalities (TEXT) is not supported by the model. models/${MODEL} accepts the following combination of response modalities:\\n* AUDIO\\n","status":"INVALID_ARGUMENT"}}`,
  },
  {
    name: "Google generateContent 400 bidiGenerateContent only",
    provider: "google",
    status: 400,
    body: `{"error":{"code":400,"message":"models/${MODEL} only supports real-time bidirectional streaming via WebSocket (bidiGenerateContent). Please use the Gemini Live API (bidiGenerateContent via WebSocket) instead of generateContent.","status":"INVALID_ARGUMENT"}}`,
  },
];

// The shapes each catalog owner publishes: OpenAI `modelIdCatalog`, Google `listedModelIds`.
function listing(provider: string, modelIds: string[]): ProviderCatalogOutcome[] {
  return [
    provider === "google"
      ? { provider, status: "ready", listedModelIds: modelIds }
      : {
          provider,
          status: "ready",
          modelIdCatalog: { baseUrl: "https://api.openai.com/v1", modelIds },
        },
  ];
}

function makeInput(
  response: { status: number; body: string; provider?: string },
  options: { fallbackConfigured: boolean; listed?: string[] },
) {
  const provider = response.provider ?? "openai";
  const input = makeAssistantFailureInput(
    { provider, model: MODEL, content: [], ...projectProviderError(response) },
    { fallbackConfigured: options.fallbackConfigured },
  );
  input.providerOutcomes = listing(provider, options.listed ?? [MODEL, "fixture-chat-model"]);
  return input;
}

async function surfacedFailure(input: ReturnType<typeof makeInput>): Promise<FailoverError> {
  const failure = await handleEmbeddedAssistantFailure(input).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FailoverError);
  return failure as FailoverError;
}

function replyText(failure: FailoverError) {
  return buildKnownAgentRunFailureReplyPayload({
    err: failure,
    sessionCtx: {},
    resolvedVerboseLevel: "off",
  })?.text;
}

describe("listed model chat rejection", () => {
  beforeEach(() => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(REJECTIONS)("explains $name without persisting health", async (response) => {
    const input = makeInput(response, { fallbackConfigured: false });
    const failure = await surfacedFailure(input);
    expect(failure).toMatchObject({
      reason: "format",
      code: "model_chat_rejected",
      status: response.status,
    });
    expect(replyText(failure)).toBe(REJECTED_COPY);
    expect(input.failover.advanceAuthProfile).not.toHaveBeenCalled();
    expect(input.failover.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
  });

  it.each(REJECTIONS)("advances to the next model once for $name", async (response) => {
    let primaryAttempts = 0;
    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "openai",
      model: MODEL,
      manifestPlugins: [],
      skipAuthProfileRuntime: true,
      fallbacksOverride: ["anthropic/fixture-next"],
      run: async (provider) => {
        if (provider === "anthropic") {
          return "Fallback answered.";
        }
        const input = makeInput(response, { fallbackConfigured: true });
        for (;;) {
          primaryAttempts += 1;
          if ((await handleEmbeddedAssistantFailure(input)).action !== "retry") {
            throw new Error("rejection was not surfaced");
          }
        }
      },
    });
    expect(result).toMatchObject({ provider: "anthropic", result: "Fallback answered." });
    expect(primaryAttempts).toBe(1);
  });

  it.each([
    {
      name: "a 404 for a model missing from the listing",
      response: MODEL_DOES_NOT_EXIST,
      listed: ["fixture-chat-model"],
      reason: "model_not_found",
    },
    {
      name: "a 500",
      response: {
        status: 500,
        body: '{"error":{"message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.","type":"server_error","param":null,"code":"server_error"}}',
      },
      reason: "server_error",
    },
    {
      name: "a 429",
      response: {
        status: 429,
        body: `{"error":{"message":"Rate limit reached for ${MODEL} on requests per min (RPM): Limit 3, Used 3, Requested 1.","type":"requests","param":null,"code":"rate_limit_exceeded"}}`,
      },
      reason: "rate_limit",
    },
    {
      name: "a 401",
      response: {
        status: 401,
        body: '{"error":{"message":"Incorrect API key provided: sk-fixture. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}',
      },
      reason: "auth",
    },
  ])("keeps $name on its existing path", async ({ response, listed, reason }) => {
    const failure = await surfacedFailure(
      makeInput(response, { fallbackConfigured: false, listed }),
    );
    expect(failure.reason).toBe(reason);
    expect(failure.code).not.toBe("model_chat_rejected");
    expect(replyText(failure)).not.toBe(REJECTED_COPY);
  });

  it("leaves an empty successful reply to the empty-response path", async () => {
    const input = makeInput(MODEL_DOES_NOT_EXIST, { fallbackConfigured: false });
    Object.assign(input.normalizedAttempt.attemptAssistant, {
      stopReason: "stop",
      errorMessage: undefined,
      errorCode: undefined,
      errorType: undefined,
      errorBody: undefined,
    });
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("proceed");
  });
});
