import { describe, expect, it } from "vitest";
import {
  formatQQBotAccessTokenError,
  formatQQBotNetworkError,
  formatQQBotNotConfiguredMessage,
} from "./setup-guidance.js";

describe("QQBot setup guidance", () => {
  it("points default-account setup errors to env vars and docs", () => {
    expect(formatQQBotNotConfiguredMessage("default")).toContain(
      "Set QQBOT_APP_ID and QQBOT_CLIENT_SECRET",
    );
    expect(formatQQBotNotConfiguredMessage("default")).toContain(
      "https://docs.openclaw.ai/channels/qqbot",
    );
  });

  it("points named-account setup errors to account config keys", () => {
    const message = formatQQBotNotConfiguredMessage("work");

    expect(message).toContain("channels.qqbot.accounts.work.appId");
    expect(message).toContain("channels.qqbot.accounts.work.clientSecret");
    expect(message).not.toContain("Set QQBOT_APP_ID and QQBOT_CLIENT_SECRET");
  });

  it("keeps token and network failures actionable without dropping details", () => {
    expect(formatQQBotAccessTokenError('{"code":400}')).toContain(
      "Failed to get QQBot access token.",
    );
    expect(formatQQBotAccessTokenError('{"code":400}')).toContain("Response: {\"code\":400}");
    expect(formatQQBotNetworkError("/gateway", "fetch failed")).toContain(
      "server IP is whitelisted",
    );
  });
});
