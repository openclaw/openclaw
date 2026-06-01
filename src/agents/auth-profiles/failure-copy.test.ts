import { describe, expect, it, vi } from "vitest";

vi.mock("../provider-auth-recovery-hint.js", () => ({
  buildProviderAuthRecoveryHint: (params: { provider: string }) =>
    `Run \`openclaw models auth login --provider ${params.provider}\`.`,
}));

import { formatAuthProfileFailureMessage } from "./failure-copy.js";

describe("formatAuthProfileFailureMessage", () => {
  describe("allInCooldown: true", () => {
    it("renders the auth reason with a login recovery hint", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: "openai-codex",
        allInCooldown: true,
      });
      expect(message).toBe(
        "Couldn't sign in to openai-codex. Your saved login looks expired or no longer works. Run `openclaw models auth login --provider openai-codex`.",
      );
    });

    it("renders the billing reason with a login recovery hint", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "billing",
        provider: "anthropic",
        allInCooldown: true,
      });
      expect(message).toBe(
        "anthropic rejected the request — looks like a billing issue on the account. Run `openclaw models auth login --provider anthropic`.",
      );
    });

    it("does not append a login hint for transient rate_limit cooldowns", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "rate_limit",
        provider: "openai-codex",
        allInCooldown: true,
      });
      expect(message).toBe(
        "openai-codex is asking us to slow down. Please wait a moment before trying again.",
      );
    });

    it("falls back to a generic sentence for unknown reasons", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: "openai-codex",
        allInCooldown: true,
      });
      expect(message).toBe(
        "Couldn't reach openai-codex with any of your saved logins right now. Run `openclaw models auth login --provider openai-codex`.",
      );
    });
  });

  describe("allInCooldown: false", () => {
    it("renders the auth reason with a login hint when a credential is broken", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: "openai-codex",
        allInCooldown: false,
        cause: new Error("invalid_grant"),
      });
      expect(message).toBe(
        "Couldn't sign in to openai-codex. Your saved login looks expired or no longer works. Run `openclaw models auth login --provider openai-codex`. (invalid_grant)",
      );
    });

    it("returns the underlying error message when no actionable reason matches", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: "openai-codex",
        allInCooldown: false,
        cause: new Error("upstream provider returned 502"),
      });
      expect(message).toBe("upstream provider returned 502");
    });

    it("returns the generic sentence when no reason and no cause apply", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: "openai-codex",
        allInCooldown: false,
      });
      expect(message).toBe("Couldn't reach openai-codex with any of your saved logins right now.");
    });

    it("does not duplicate the cause text when it already appears in the description", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: "openai-codex",
        allInCooldown: false,
        cause: new Error(
          "Couldn't sign in to openai-codex. Your saved login looks expired or no longer works",
        ),
      });
      expect(message).toBe(
        "Couldn't sign in to openai-codex. Your saved login looks expired or no longer works. Run `openclaw models auth login --provider openai-codex`.",
      );
    });
  });
});
