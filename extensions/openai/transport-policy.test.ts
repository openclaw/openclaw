import type {
  ProviderRuntimeModel,
  ProviderResolveTransportTurnStateContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { resolveOpenAITransportTurnState } from "./transport-policy.js";

const nativeModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies ProviderRuntimeModel;

function turnState(overrides: Partial<ProviderResolveTransportTurnStateContext>) {
  return resolveOpenAITransportTurnState({
    provider: nativeModel.provider,
    modelId: nativeModel.id,
    model: nativeModel,
    sessionId: "session-123",
    turnId: "turn-123",
    attempt: 2,
    transport: "websocket",
    ...overrides,
  });
}

it.each([
  ["openai", "openai-responses", "https://api.openai.com/v1", "websocket"],
  ["openai", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "stream"],
  [
    "azure-openai-responses",
    "openai-responses",
    "https://demo.openai.azure.com/openai/v1",
    "websocket",
  ],
  ["openai", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "websocket"],
] as const)(
  "builds native turn state for %s / %s / %s / %s",
  (provider, api, baseUrl, transport) => {
    const state = turnState({
      provider,
      model: { ...nativeModel, provider, api, baseUrl },
      transport,
    });
    const sessionHeaders = {
      "x-client-request-id": "session-123",
      "x-openclaw-session-id": "session-123",
    };
    expect(state?.headers).toMatchObject({
      ...sessionHeaders,
      "x-openclaw-turn-id": "turn-123",
      "x-openclaw-turn-attempt": "2",
    });
    expect(state?.metadata).toMatchObject({
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
      openclaw_turn_attempt: "2",
      openclaw_transport: transport,
    });
    if (transport === "websocket") {
      expect(state?.websocket).toEqual({ headers: sessionHeaders, degradeCooldownMs: 60_000 });
    }
  },
);

it("skips turn state for proxy-like OpenAI routes", () => {
  expect(
    turnState({
      model: { ...nativeModel, baseUrl: "https://proxy.example.com/v1" },
      transport: "stream",
    }),
  ).toBeUndefined();
});
