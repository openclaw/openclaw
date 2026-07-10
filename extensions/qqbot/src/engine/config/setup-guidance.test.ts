import { describe, expect, it } from "vitest";
import { qqbotNotConfiguredMessage, qqbotSetupGuidance } from "./setup-guidance.js";

describe("QQBot setup guidance", () => {
  it("offers default-account config and environment variables", () => {
    const message = qqbotNotConfiguredMessage("default");

    expect(message).toContain("channels.qqbot.appId");
    expect(message).toContain("QQBOT_APP_ID and QQBOT_CLIENT_SECRET");
  });

  it("directs named accounts to account-scoped config without default-only environment variables", () => {
    const message = qqbotNotConfiguredMessage("operations");

    expect(message).toContain("channels.qqbot.accounts.operations.appId");
    expect(message).toContain("clientSecret (or clientSecretFile)");
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(message).not.toContain("QQBOT_CLIENT_SECRET");
  });

  it("keeps context-free API guidance account-neutral", () => {
    const message = qqbotSetupGuidance();

    expect(message).toContain("QQBot account appId");
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(message).not.toContain("QQBOT_CLIENT_SECRET");
  });
});
