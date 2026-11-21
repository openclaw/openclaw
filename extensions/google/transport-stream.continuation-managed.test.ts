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

afterEach(() => vi.unstubAllEnvs());

describe("Google continuation through managed HTTP", () => {
  it.each([
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
  ])("preserves $name at HTTP EOF", async ({ tail, error }) => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    const requests: {
      method: string | undefined;
      url: string | undefined;
      key: string | undefined;
    }[] = [];
    await withServer(
      (request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          key: request.headers.authorization,
        });
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(continued + tail);
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
          expect(result.providerReplay?.id).toBe(token);
        }
      },
    );
  });
});
