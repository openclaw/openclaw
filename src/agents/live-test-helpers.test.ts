import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, readRuntimeConfig } from "../config/runtime-snapshot.js";
import { completeSimple } from "../llm/stream.js";
import {
  completeSimpleWithTimeout,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
  resolveLiveCredentialPrecedence,
  useLiveTestRuntimeConfig,
} from "./live-test-helpers.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

vi.mock("../llm/stream.js", () => ({ completeSimple: vi.fn() }));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  vi.mocked(completeSimple).mockReset();
});

it.each(["success", "failure"])("clears its published config after %s", (outcome) => {
  clearRuntimeConfigSnapshot();
  expect(() => readRuntimeConfig()).toThrow("Runtime config is not prepared");
  const config = { agents: { entries: { live: { workspace: "/synthetic/live" } } } };
  const runFixture = () => {
    using _ = useLiveTestRuntimeConfig(config);
    expect(readRuntimeConfig()).toEqual(config);
    if (outcome === "failure") {
      throw new Error("synthetic live failure");
    }
  };
  if (outcome === "failure") {
    expect(runFixture).toThrow("synthetic live failure");
  } else {
    runFixture();
  }
  expect(() => readRuntimeConfig()).toThrow("Runtime config is not prepared");
});
const model = makeProviderModelFixture({
  id: "test-model",
  provider: "test-provider",
  api: "openai-responses",
  baseUrl: "https://example.com",
});
const response = makeAgentAssistantMessage({ content: [] });

it.each(["success", "failure"])("releases timeout timers after early %s", async (outcome) => {
  vi.useFakeTimers();
  const error = new Error("provider failed");
  if (outcome === "success") {
    vi.mocked(completeSimple).mockResolvedValue(response);
  } else {
    vi.mocked(completeSimple).mockRejectedValue(error);
  }
  const completion = completeSimpleWithTimeout(model, { messages: [] }, {}, 1_000);
  const settled = expect(completion)[outcome === "success" ? "resolves" : "rejects"];
  await settled.toBe(outcome === "success" ? response : error);
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
it.each([
  ["LIVE", true, false],
  ["OPENCLAW_LIVE_TEST", true, false],
  ["OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS", false, true],
  ["unset", false, false],
] as const)("keeps live and profile-key gates distinct: %s", (flag, live, profileKeys) => {
  const env = flag === "unset" ? {} : { [flag]: "1" };
  expect({
    live: isLiveTestEnabled([], env),
    profileKeys: isLiveProfileKeyModeEnabled(env),
  }).toEqual({ live, profileKeys });
});
it("keeps env-first auth for normal providers unless profile keys are required", () => {
  expect(resolveLiveCredentialPrecedence("anthropic", false)).toBe("env-first");
  expect(resolveLiveCredentialPrecedence("anthropic", true)).toBe("profile-first");
});
