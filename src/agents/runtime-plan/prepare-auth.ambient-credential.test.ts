import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

const oauthStore = (expires: number): AuthProfileStore => ({
  version: 1,
  profiles: {
    "anthropic:claude-cli": {
      type: "oauth",
      provider: "claude-cli",
      access: "subscription-token",
      refresh: "refresh-token",
      expires,
    },
  } as unknown as AuthProfileStore["profiles"],
});

const config = {
  plugins: { entries: { anthropic: { enabled: false } } },
  models: {
    providers: { "claude-cli": { models: [{ id: "claude-fable-5" }] } },
  },
  agents: {
    defaults: {
      model: { primary: "claude-cli/claude-fable-5" },
      models: { "claude-cli/claude-fable-5": { alias: "fable5" } },
    },
  },
} as unknown as OpenClawConfig;

describe("ambient provider credentials are not queued behind a declared profile", () => {
  // Regression #117956: losing a subscription must not bill an undeclared account.
  it("does not substitute ambient auth", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "claude-cli",
      modelId: "claude-fable-5",
      config,
      env: { ANTHROPIC_API_KEY: "ambient-anthropic-key" },
      authProfileStore: oauthStore(Date.now() + 3_600_000),
    });
    expect(prepared.attempts).toMatchObject([
      { kind: "profile", profileId: "anthropic:claude-cli" },
    ]);
  });
});
