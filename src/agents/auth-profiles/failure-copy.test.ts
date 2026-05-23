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
        "Every auth profile for openai-codex is currently failing authentication; sessions look expired or credentials were rejected. Run `openclaw models auth login --provider openai-codex`.",
      );
    });

    it("renders the billing reason with a login recovery hint", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "billing",
        provider: "anthropic",
        allInCooldown: true,
      });
      expect(message).toBe(
        "Every auth profile for anthropic is blocked for billing on the provider account. Run `openclaw models auth login --provider anthropic`.",
      );
    });

    it("does not append a login hint for transient rate_limit cooldowns", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "rate_limit",
        provider: "openai-codex",
        allInCooldown: true,
      });
      expect(message).toBe(
        "Every auth profile for openai-codex is cooling down after recent rate-limit responses.",
      );
    });

    it("falls back to a generic cooldown sentence for unknown reasons", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: "openai-codex",
        allInCooldown: true,
      });
      expect(message).toBe(
        "No openai-codex auth profile is currently available; all are in cooldown or blocked. Run `openclaw models auth login --provider openai-codex`.",
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
        "Authentication with openai-codex did not succeed. Run `openclaw models auth login --provider openai-codex`. (invalid_grant)",
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

    it("returns the generic cooldown sentence when no reason and no cause apply", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: "openai-codex",
        allInCooldown: false,
      });
      expect(message).toBe(
        "No openai-codex auth profile is currently available; all are in cooldown or blocked.",
      );
    });

    it("does not duplicate the cause text when it already appears in the description", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: "openai-codex",
        allInCooldown: false,
        cause: new Error("Authentication with openai-codex did not succeed"),
      });
      expect(message).toBe(
        "Authentication with openai-codex did not succeed. Run `openclaw models auth login --provider openai-codex`.",
      );
    });
  });
});
