import { describe, expect, it } from "vitest";
import type { GatewayAccount } from "../types.js";
import { sendMedia, sendText } from "./outbound.js";

function account(overrides: Partial<GatewayAccount> = {}): GatewayAccount {
  return {
    accountId: "qqbot",
    appId: "",
    clientSecret: "",
    markdownSupport: false,
    config: {},
    ...overrides,
  };
}

describe("QQBot outbound configuration errors", () => {
  it("returns actionable setup guidance for text sends without credentials", async () => {
    const result = await sendText({
      to: "c2c:user-openid",
      text: "hello",
      account: account(),
    });

    expect(result.error).toMatch(
      /QQBot not configured.*QQBOT_APP_ID.*QQBOT_CLIENT_SECRET.*openclaw configure.*https:\/\/q\.qq\.com\/.*https:\/\/docs\.openclaw\.ai\/channels\/qqbot/,
    );
  });

  it("returns actionable setup guidance for media sends without credentials", async () => {
    const result = await sendMedia({
      to: "c2c:user-openid",
      text: "hello",
      mediaUrl: "https://cdn.example.com/image.png",
      account: account(),
    });

    expect(result.error).toMatch(
      /QQBot not configured.*QQBOT_APP_ID.*QQBOT_CLIENT_SECRET.*openclaw configure.*https:\/\/q\.qq\.com\/.*https:\/\/docs\.openclaw\.ai\/channels\/qqbot/,
    );
  });

  it("returns account-scoped setup guidance for named accounts", async () => {
    const result = await sendText({
      to: "c2c:user-openid",
      text: "hello",
      account: account({ accountId: "ops", appId: "app-id" }),
    });

    expect(result.error).toMatch(
      /QQBot account "ops" is not configured.*channels\.qqbot\.accounts\.ops\.appId.*channels\.qqbot\.accounts\.ops\.clientSecret.*QQBOT_APP_ID.*default QQBot account/,
    );
  });
});
