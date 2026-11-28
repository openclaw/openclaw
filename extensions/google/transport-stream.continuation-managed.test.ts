import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
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
