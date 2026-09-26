export const OPENAI_AUTH_POLICY_CASES = [
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
] as const;
