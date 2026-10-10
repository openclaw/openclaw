// Covers shared live-test gates and credential precedence rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSimple } from "../llm/stream.js";
import {
  completeSimpleWithTimeout,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
  resolveLiveCredentialPrecedence,
} from "./live-test-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

vi.mock("../llm/stream.js", () => ({ completeSimple: vi.fn() }));

describe("completeSimpleWithTimeout", () => {
  const model = makeProviderModelFixture({
    id: "test-model",
    provider: "test-provider",
    api: "openai-responses",
    baseUrl: "https://example.com",
  });
  const response = buildAssistantMessage({
    model,
    content: [],
    stopReason: "stop",
    usage: buildUsageWithNoCost({}),
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(completeSimple).mockReset();
  });

  it.each(["success", "failure"])("releases timeout timers after early %s", async (outcome) => {
    vi.useFakeTimers();
    const error = new Error("provider failed");
    if (outcome === "success") {
      vi.mocked(completeSimple).mockResolvedValue(response);
    } else {
      vi.mocked(completeSimple).mockRejectedValue(error);
    }
    const completion = completeSimpleWithTimeout(model, { messages: [] }, {}, 1_000);
    if (outcome === "success") {
      await expect(completion).resolves.toBe(response);
    } else {
      await expect(completion).rejects.toBe(error);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and rejects a provider that does not settle at its deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(completeSimple).mockImplementation(() => new Promise(() => {}));
    const completion = completeSimpleWithTimeout(model, { messages: [] }, {}, 1_000);
    const rejected = expect(completion).rejects.toThrow("model call timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.mocked(completeSimple).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isLiveTestEnabled", () => {
  it("treats LIVE and OPENCLAW_LIVE_TEST as shared live gates", () => {
    expect(isLiveTestEnabled([], { LIVE: "1" })).toBe(true);
    expect(isLiveTestEnabled([], { OPENCLAW_LIVE_TEST: "1" })).toBe(true);
    expect(isLiveTestEnabled([], {})).toBe(false);
  });

  it("supports provider-specific live flags", () => {
    expect(isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "1" })).toBe(true);
    expect(isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "0" })).toBe(false);
  });
});

describe("isLiveProfileKeyModeEnabled", () => {
  it("only enables profile-key mode for the dedicated flag", () => {
    expect(isLiveProfileKeyModeEnabled({ OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS: "1" })).toBe(true);
    expect(isLiveProfileKeyModeEnabled({ OPENCLAW_LIVE_TEST: "1" })).toBe(false);
    expect(isLiveProfileKeyModeEnabled({ LIVE: "1" })).toBe(false);
  });
});

describe("live credential precedence", () => {
  it("uses profile-first auth for OpenAI even when the global live mode is env-first", () => {
    // Prefer stored OpenAI profiles without excluding the documented env fallback.
    expect(resolveLiveCredentialPrecedence("openai", false)).toBe("profile-first");
  });

  it("keeps env-first auth for normal providers unless profile keys are required", () => {
    expect(resolveLiveCredentialPrecedence("anthropic", false)).toBe("env-first");
    expect(resolveLiveCredentialPrecedence("anthropic", true)).toBe("profile-first");
  });
});
