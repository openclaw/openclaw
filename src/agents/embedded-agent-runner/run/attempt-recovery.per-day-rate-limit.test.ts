import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { describe, expect, it, vi } from "vitest";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../../test-utils/plugin-registration.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

/** A real HTTP round-trip through the real OpenRouter transport, feeding the
 * exact reported per-day-cap 429 body. Used so the production retry
 * controller is exercised against transport-truth text, not a hand-typed
 * string (#147546 / PR real-transport proof requests). */
async function fetchRealPerDayCapErrorMessage(): Promise<string | undefined> {
  const { default: openrouterPlugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "openrouter", artifactBasename: "index.js" });
  await registerSingleProviderPlugin(openrouterPlugin);

  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(429, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { code: 429, message: "Rate limit exceeded: free-models-per-day-high-balance." },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const model = {
      id: "example/model",
      name: "OpenRouter mock",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_024,
    } satisfies Model<"openai-completions">;
    const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
    const result = await streamOpenAICompletions(model, context, {
      apiKey: ["test", "key"].join("-"),
    }).result();
    return buildAssistantFailoverSignal(result).message;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("recoverEmbeddedRunAttempt", () => {
  it("routes a real HTTP per-day 429 straight to fallback with zero same-model retries", async () => {
    // Message text comes from a real local HTTP 429 response round-tripped through
    // the real OpenRouter transport (streamOpenAICompletions) and the real
    // buildAssistantFailoverSignal() — the same production text attempt-recovery.ts:331
    // passes into failoverRetryController.maybeRetryTransient() as retry.message.
    const realErrorMessage = await fetchRealPerDayCapErrorMessage();
    expect(realErrorMessage).toContain("free-models-per-day-high-balance");

    vi.mocked(sleepWithAbort).mockClear();
    const fixture = await recoverAfterTransportDrop({
      errorMessage: realErrorMessage,
      diagnostics: [],
      content: [],
      replaySafe: true,
    });

    // The exhausted-daily-cap guard at failover-retry-controller.ts:232 must trip on
    // the very first attempt: immediate fallback, never a same-model retry burned
    // against a cap that a retry cannot recover from.
    expect(fixture.recovery).toEqual({ action: "proceed" });
    expect(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
    expect(fixture.markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(sleepWithAbort).not.toHaveBeenCalled();
    expect(fixture.failoverRetryController.transientRetryCount).toBe(0);
  });
});
