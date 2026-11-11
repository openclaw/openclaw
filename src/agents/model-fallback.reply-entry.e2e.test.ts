// Routing/retry and delivery are covered by the fallback and reply-runner suites;
// keep the returned-failure payload contract at its owner.
import { expect, it } from "vitest";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "./failover/user-copy.js";
import { buildEmbeddedRunnerAssistant } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { withPreparedFailoverProviders } from "./test-helpers/provider-failover-generation.js";

it.each([
  ["openai", "rate limit exceeded", undefined],
  ["openai", "401 invalid API key", undefined],
  ["openai", "OAuth token refresh failed for openai: refresh_token_invalidated", "/login openai"],
  ["refresh", "OAuth token refresh failed for refresh: refresh_token_invalidated", "/login"],
] as const)(
  "builds the returned %s failure payload: %s",
  (provider, errorMessage, loginCommand) => {
    withPreparedFailoverProviders([provider], () => {
      const rateLimited = errorMessage === "rate limit exceeded";
      const payloads = buildPayloads({
        provider,
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider,
          model: "mock-1",
          stopReason: "error",
          errorMessage,
        }),
        rateLimitRetriesExhausted: rateLimited ? 3 : undefined,
      });
      expect(payloads).toHaveLength(1);
      const payload = payloads[0];
      expect(payload?.isError).toBe(true);
      if (rateLimited) {
        expect(payload?.text).toContain("Rate-limit recovery stopped after 3 automatic retries");
        expect(payload?.text).not.toContain("The AI service is temporarily rate-limited");
      } else if (loginCommand) {
        expect(payload?.text).toContain(loginCommand);
        expect(payload?.presentation).toEqual({
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Sign in", action: { type: "command", command: loginCommand } }],
            },
          ],
        });
      } else {
        expect(payload?.text).toBe(AUTH_INVALID_TOKEN_USER_TEXT);
        expect(payload?.presentation).toBeUndefined();
      }
    });
  },
);
