import { createServer } from "node:http";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "../../../../test/helpers/gateway-integration-fixtures.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../../test-utils/plugin-registration.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { coerceToFailoverError } from "../../failover-error.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));
beforeEach(() => vi.mocked(sleepWithAbort).mockClear());

function recoverRateLimit(scenario: Parameters<typeof recoverAfterTransportDrop>[0]) {
  return recoverAfterTransportDrop({
    diagnostics: [],
    content: [],
    replaySafe: true,
    ...scenario,
  });
}

// Keep #147546's transport-truth 429 text, rather than hand-projecting an error.
async function fetchRealPerDayCapErrorMessage(): Promise<string | undefined> {
  const { default: openrouterPlugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "openrouter", artifactBasename: "index.js" });
  await registerSingleProviderPlugin(openrouterPlugin);
  const message = "Rate limit exceeded: free-models-per-day-high-balance.";
  const server = createServer((request, response) => {
    request.resume();
    respondJson(response, { error: { code: 429, message } }, 429);
  });
  const url = await listenLoopback(server);
  try {
    const model = makeProviderModelFixture<"openai-completions">({
      id: "example/model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: `${url}/api/v1`,
    });
    const result = await streamOpenAICompletions(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: ["test", "key"].join("-") },
    ).result();
    return buildAssistantFailoverSignal(result).message;
  } finally {
    await closeHttpServer(server);
  }
}

it.each(["assistant", "prompt", "coerced"] as const)(
  "does not retry a code-only HTTP 400 rejection from %s",
  async (source) => {
    const message = "400 This prompt is longer than the free tier allows for a single request.";
    const code = "rate_limit_exceeded";
    const error = Object.assign(new Error(message), { status: 400, code });
    const recovery = recoverRateLimit({
      errorMessage: message,
      errorCode: code,
      fallbackConfigured: true,
      terminal:
        source === "assistant"
          ? undefined
          : {
              kind: "failed",
              source: "prompt",
              error: source === "coerced" ? coerceToFailoverError(error) : error,
            },
    });
    if (source === "assistant") {
      await expect(recovery).resolves.toMatchObject({ recovery: { action: "proceed" } });
    } else {
      await expect(recovery).rejects.toMatchObject({
        name: "FailoverError",
        reason: "rate_limit",
        status: 400,
      });
    }
    expect(sleepWithAbort).not.toHaveBeenCalled();
  },
);

it("routes a real HTTP per-day 429 straight to fallback with zero same-model retries", async () => {
  const realErrorMessage = await fetchRealPerDayCapErrorMessage();
  expect(realErrorMessage).toContain("free-models-per-day-high-balance");

  const fixture = await recoverRateLimit({ errorMessage: realErrorMessage });

  expect(fixture.recovery).toEqual({ action: "proceed" });
  expect(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
  expect(fixture.markOwnedTranscriptRetry).not.toHaveBeenCalled();
  expect(sleepWithAbort).not.toHaveBeenCalled();
  expect(fixture.failoverRetryController.transientRetryCount).toBe(0);
});

it.each<[string, "proceed" | "retry", number]>([
  // MiniMax Token Plan 2056 from #172165, without Retry-After.
  [
    '429: {"error":{"message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","type":"rate_limit_error"},"type":"error"}',
    "proceed",
    0,
  ],
  // z.ai weekly/monthly quota from #173436.
  ["429 您已达到每周/每月使用上限，您的限额将在 2026-10-20 00:00:00 重置。", "proceed", 0],
  ["429 您已达到每周使用上限，请等待限额重置。", "proceed", 0],
  ["429 您已达到每月使用上限，请等待限额重置。", "proceed", 0],
  ["429 额度已用尽", "proceed", 0],
  ["429 配额已用尽", "proceed", 0],
  ["429 您已达到每分钟使用上限，请稍后重试。", "retry", 1],
  ["429 请求过于频繁，请稍后重试", "retry", 1],
  ["429 请求过于频繁; please retry later", "retry", 1],
])("Chinese quota recovery: %s", async (errorMessage, action, retries) => {
  const fixture = await recoverRateLimit({ errorMessage });

  expect(fixture.recovery.action).toBe(action);
  expect(sleepWithAbort).toHaveBeenCalledTimes(retries);
  expect(fixture.failoverRetryController.transientRetryCount).toBe(retries);
});
