import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildClawRouterDecisionProvider } from "./decision-provider.js";

const guard = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: guard.fetch,
}));

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "Only supplied evidence" },
  questions: { q: { type: "boolean" } },
};

function context(baseUrl: string): DecisionProviderContextV2 {
  return {
    model: attachModelProviderRequestTransport(
      {
        provider: "clawrouter",
        id: "openai/gpt-6-luna",
        name: "Luna",
        api: "openai-responses",
        baseUrl,
      },
      { allowPrivateNetwork: true },
    ),
    auth: { mode: "api-key", apiKey: "synthetic-router-key" },
    config: {},
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5000,
    isAdmissible: () => true,
  };
}

beforeEach(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

it.each(["pending", "rejected"])(
  "classifies catalog failures when body cancellation is %s and completes transport release",
  async (settlement) => {
    const cancel = vi.fn(() =>
      settlement === "pending"
        ? new Promise<void>(() => {})
        : Promise.reject(new Error("synthetic cancellation failure")),
    );
    const release = vi.fn(async () => {});
    guard.fetch.mockResolvedValueOnce({
      response: new Response(new ReadableStream({ cancel }), {
        status: 429,
        headers: { "retry-after": "2" },
      }),
      finalUrl: "https://router.example/v1/catalog",
      release,
    });
    await expect(
      buildClawRouterDecisionProvider().evaluate(batch, context("https://router.example")),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "rate-limited",
      retryAfterMs: 2000,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  },
);
