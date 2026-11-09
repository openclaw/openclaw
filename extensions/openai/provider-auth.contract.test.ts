// Openai tests cover provider auth.contract plugin behavior.
import { describeOpenAICodexProviderAuthContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";
import { resolveModelAuthPolicy } from "./provider-policy-api.js";

const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-oauth.runtime.js", () => ({
  loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
}));

describeOpenAICodexProviderAuthContract(() => import("./index.js"), {
  expectedCodexDefaultModel: OPENAI_CODEX_DEFAULT_MODEL,
  loginOpenAICodexOAuthMock,
});

describe("OpenAI provider model authentication policy", () => {
  it.each([
    ["oauth", undefined, "openai-chatgpt-responses", undefined, "subscription", true],
    ["api-key", undefined, "openai-responses", undefined, "api-key", true],
    [
      "oauth",
      "chatgpt-token-sharing",
      "openai-responses",
      "https://api.openai.com/v1",
      "api-key",
      true,
    ],
    ["oauth", "chatgpt-token-sharing", "openai-chatgpt-responses", undefined, "api-key", false],
    [
      "oauth",
      "chatgpt-token-sharing",
      "openai-responses",
      "https://example.com/v1",
      "api-key",
      false,
    ],
    ["oauth", "chatgpt-identity", "openai-responses", undefined, null, false],
  ] as const)(
    "authorizes %s/%s for %s at %s as %s: %s",
    (mode, authFlow, api, baseUrl, authRequirement, compatible) => {
      expect(
        resolveModelAuthPolicy({ provider: "openai", mode, authFlow, api, baseUrl }),
      ).toMatchObject({
        authRequirement,
        compatible,
      });
    },
  );
});
