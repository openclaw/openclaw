import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it } from "vitest";
import { discordSetupContract } from "./setup-adapter.js";

const validate = (input: unknown) =>
  discordSetupContract.validateInput?.({
    cfg: {},
    accountId: DEFAULT_ACCOUNT_ID,
    input,
  });

describe("discord setup adapter token shape", () => {
  it("rejects a numeric application ID used as the bot token after trimming", () => {
    const error = validate({ token: " 1234567890123456789 " });
    expect(error).toContain("application ID");
    expect(error).toContain("Discord Developer Portal (Bot page)");
  });

  it("does not enforce a token format for nonnumeric strings", () => {
    expect(validate({ token: "opaque-token" })).toBeNull();
  });

  it("leaves non-string credential references to the contract type check", () => {
    expect(validate({ token: { source: "exec", provider: "vault", id: "discord/work" } })).toBe(
      "token must be a string.",
    );
  });

  it("preserves the env-backed setup flow", () => {
    expect(validate({ useEnv: true })).toBeNull();
  });

  it("keeps the missing-credential error for empty input", () => {
    expect(validate({})).toBe("Discord requires token (or --use-env).");
  });
});
