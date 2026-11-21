import { hash } from "node:crypto";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import { modelRequestBodyState } from "../../packages/ai/src/transports/model-request-body.js";
import {
  wrapStreamFnWithProviderPromptState,
  type ProviderPromptState,
} from "../../src/agents/embedded-agent-runner/provider-prompt-state.js";
import { buildGoogleProvider } from "./provider-registration.js";

const token = "synthetic-managed-continuation";
const continued = `data: ${JSON.stringify({
  candidates: [
    {
      finishReason: "CONTINUATION",
      continuationToken: token,
      content: { parts: [{ text: "partial response" }] },
    },
  ],
})}\n\n`;
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const checkpoint = (finishReason: null | undefined, continuationToken: unknown = "checkpoint") =>
  frame({
    candidates: [
      { continuationToken, finishReason, content: { parts: [{ text: "checkpoint " }] } },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 },
  });

type ManagedCase = {
  name: string;
  tail?: string;
  wire?: string;
  error?: string;
  receipt?: boolean;
  checkpointOnly?: boolean;
  preservesCheckpoint?: boolean;
};

afterEach(() => vi.unstubAllEnvs());

describe("Google continuation through managed HTTP", () => {
  it.each<ManagedCase>([
    { name: "completed continuation", tail: "", error: undefined },
    {
      name: "standalone error event",
      tail: "event: error\n\n",
      error: "Google continuation stream returned an error event",
    },
    {
      name: "bare JSON error tail",
      tail: JSON.stringify({ error: { message: "synthetic terminal failure", code: 503 } }),
      error: "synthetic terminal failure",
    },
    ...[undefined, null].flatMap((finishReason) => [
      {
        name: `${String(finishReason)} checkpoint before final continuation`,
        wire: checkpoint(finishReason) + continued,
        preservesCheckpoint: true,
      },
      {
        name: `${String(finishReason)} checkpoint alone`,
        wire: checkpoint(finishReason),
        error: "Google stream ended before a terminal finish reason",
        receipt: false,
        checkpointOnly: true,
        preservesCheckpoint: true,
      },
    ]),
    ...["", 42, "x".repeat(16 * 1024 + 1)].map((invalidToken, index) => ({
      name: `malformed checkpoint token ${index}`,
      wire: checkpoint(null, invalidToken) + continued,
      receipt: false,
    })),
    {
      name: "contradictory final tokens",
      wire:
        continued +
        frame({ candidates: [{ finishReason: "CONTINUATION", continuationToken: "other" }] }),
      receipt: false,
    },
    ...["STOP", "FINISH_REASON_UNSPECIFIED"].map((finishReason) => ({
      name: `token with ${finishReason}`,
      wire: frame({ candidates: [{ finishReason, continuationToken: "checkpoint" }] }) + continued,
      receipt: false,
    })),
  ])("preserves $name at HTTP EOF", async (testCase) => {
    const {
      tail = "",
      wire = continued + tail,
      error,
      receipt = true,
      checkpointOnly = false,
      preservesCheckpoint = false,
    } = testCase;
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    const requests: Record<"method" | "url" | "key", string | undefined>[] = [];
    await withServer(
      (request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          key: request.headers.authorization,
        });
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(wire);
      },
      async (origin) => {
        const model = makeProviderModel("google-generative-ai", "clawrouter", "gemini-3.5-flash", {
          baseUrl: `${origin}/v1/native/google-gemini/v1beta`,
        });
        const streamFn = buildGoogleProvider().createStreamFn?.({
          provider: model.provider,
          modelId: model.id,
          model,
        });
        assert(streamFn, "registered Google transport must be available");
        const stream = await streamFn(
          model,
          { messages: [{ role: "user", content: "synthetic request", timestamp: 0 }] },
          {
            apiKey: "synthetic-router-key",
            headers: { Authorization: "Bearer synthetic-router-key" },
          },
        );
        const result = await stream.result();
        expect(requests).toEqual([
          {
            method: "POST",
            url: "/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
            key: "Bearer synthetic-router-key",
          },
        ]);
        if (error) {
          expect(result.providerReplay).toBeUndefined();
          expect(result.stopReason).toBe("error");
          expect(result.errorMessage).toContain(error);
        } else {
          expect(result.stopReason).toBe("length");
          if (receipt) {
            expect(result.providerReplay?.id).toBe(token);
          } else {
            expect(result.providerReplay).toBeUndefined();
          }
        }
        if (preservesCheckpoint) {
          expect(result.content).toEqual([
            expect.objectContaining({
              type: "text",
              text: checkpointOnly ? "checkpoint " : "checkpoint partial response",
            }),
          ]);
          expect(result.usage).toMatchObject({ input: 12, output: 2, totalTokens: 14 });
        }
      },
    );
  });
});

it.each([
  { name: "changed final generation settings", changeSettings: true },
  { name: "a token hidden from final policy", omitToken: true },
  { name: "abort after final policy", abortPolicy: true },
  { name: "the final UTF-8 size after token insertion", oversizeReplay: true },
  ...["continuationToken", "continuation_token"].flatMap((injectedKey) =>
    [undefined, null, "synthetic-injected-token"].map((injectedValue) => ({
      name: `policy-injected ${injectedKey}=${String(injectedValue)}`,
      injectedKey,
      injectedValue,
    })),
  ),
])(
  "binds registered Google continuation to $name and records actual wire bytes",
  async (testCase) => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    const policyToken = "synthetic-receipt-🦞";
    const wires: string[] = [];
    const state: ProviderPromptState = {};
    const controller = new AbortController();
    let temperature = 0.25;
    const policy = vi.fn(async (payload: unknown) => {
      assert(payload && typeof payload === "object" && !Array.isArray(payload));
      const replacement: Record<string, unknown> = {
        ...payload,
        generationConfig: { temperature },
      };
      if ("omitToken" in testCase) {
        delete replacement.continuationToken;
      }
      if ("injectedKey" in testCase) {
        replacement[testCase.injectedKey] = testCase.injectedValue;
      }
      if ("oversizeReplay" in testCase) {
        replacement.contents = [];
        const prefix = JSON.stringify(replacement);
        const bytes =
          20_000_000 -
          10 -
          Buffer.byteLength(prefix) -
          Buffer.byteLength('{"role":"user","parts":[{"text":""}]}');
        replacement.contents = [
          {
            role: "user",
            parts: [{ text: "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2) }],
          },
        ];
        expect(Buffer.byteLength(JSON.stringify(replacement))).toBe(20_000_000 - 10);
      }
      if ("abortPolicy" in testCase) {
        controller.abort(false);
      }
      return replacement;
    });
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        request.on("end", () => {
          wires.push(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              candidates: [
                {
                  finishReason: "CONTINUATION",
                  continuationToken: policyToken,
                  content: { parts: [{ text: "partial response" }] },
                },
              ],
            })}\n\n`,
          );
        });
      },
      async (origin) => {
        const model = makeProviderModel("google-generative-ai", "clawrouter", "gemini-3.5-flash", {
          baseUrl: `${origin}/v1/native/google-gemini/v1beta`,
          reasoning: false,
          contextWindow: 16_000,
          maxTokens: 4_096,
        });
        const registered = buildGoogleProvider().createStreamFn?.({
          provider: model.provider,
          modelId: model.id,
          model,
        });
        assert(registered);
        const streamFn = wrapStreamFnWithProviderPromptState({
          streamFn: registered,
          state,
          effectiveContextTokenBudget: 128_000,
          transformPayload: policy,
        });
        const observedBytes: number[] = [];
        const invoke = async (googleContinuation?: AssistantMessage["providerReplay"]) => {
          const options = {
            apiKey: "synthetic-router-key",
            headers: { Authorization: "Bearer synthetic-router-key" },
            googleContinuation,
            signal: controller.signal,
          };
          modelRequestBodyState(options).onBytes = (bytes) => observedBytes.push(bytes);
          const stream = await streamFn(
            model,
            {
              messages: [{ role: "user", content: "synthetic request", timestamp: 0 }],
            },
            options,
          );
          return stream.result();
        };
        const first = await invoke();
        if ("injectedKey" in testCase || "abortPolicy" in testCase) {
          expect(first.providerReplay).toBeUndefined();
          expect(first.stopReason).toBe("abortPolicy" in testCase ? "aborted" : "error");
          expect(wires).toEqual([]);
          expect(observedBytes).toEqual([]);
          expect(policy).toHaveBeenCalledTimes(1);
          if ("abortPolicy" in testCase) {
            expect(controller.signal.reason).toBe(false);
          }
          return;
        }
        expect(first.providerReplay?.id).toBe(policyToken);
        const replay = await invoke(first.providerReplay);
        if ("oversizeReplay" in testCase) {
          expect(replay.stopReason).toBe("error");
          expect(replay.errorMessage).toContain(
            "Google request body must be smaller than 20000000 bytes",
          );
          expect(replay.providerReplay).toBeUndefined();
          expect(wires).toHaveLength(1);
          expect(observedBytes).toEqual([20_000_000 - 10]);
          expect(policy).toHaveBeenCalledTimes(2);
          return;
        }
        expect(replay.providerReplay?.id).toBe(policyToken);
        expect(wires).toHaveLength(2);
        expect(JSON.parse(wires[1]!)).toMatchObject({
          generationConfig: { temperature: 0.25 },
          continuationToken: policyToken,
        });
        expect(state.lastAttempt).toMatchObject({
          digest: hash("sha256", wires[1]!),
          byteWeight: Buffer.byteLength(wires[1]!),
          wire: { requestBytes: Buffer.byteLength(wires[1]!) },
        });
        expect(observedBytes).toEqual(wires.map((wire) => Buffer.byteLength(wire)));
        expect(policy).toHaveBeenCalledTimes(2);
        if ("changeSettings" in testCase) {
          temperature = 0.75;
          const rejected = await invoke(first.providerReplay);
          expect(rejected.stopReason).toBe("error");
          expect(rejected.providerReplay).toBeUndefined();
          expect(wires).toHaveLength(2);
          expect(policy).toHaveBeenCalledTimes(3);
        }
      },
    );
  },
);
