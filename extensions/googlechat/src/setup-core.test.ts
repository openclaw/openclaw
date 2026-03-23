import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it } from "vitest";
import { googlechatSetupAdapter } from "./setup-core.js";

describe("googlechat setup core", () => {
  it("rejects env auth for non-default accounts", () => {
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.");
  });

  it("requires inline or file credentials when env auth is not used", () => {
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, token: "", tokenFile: "" },
      } as never),
    ).toBe("Google Chat requires --token (service account JSON) or --token-file.");
  });

  it("builds a patch from token-file and trims optional webhook fields", () => {
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        cfg: { channels: { googlechat: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          tokenFile: "/tmp/googlechat.json",
          audienceType: " app-url ",
          audience: " https://example.com/googlechat ",
          webhookPath: " /googlechat ",
          webhookUrl: " https://example.com/googlechat/hook ",
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccountFile: "/tmp/googlechat.json",
          audienceType: "app-url",
          audience: "https://example.com/googlechat",
          webhookPath: "/googlechat",
          webhookUrl: "https://example.com/googlechat/hook",
        },
      },
    });
  });

  it("prefers inline token patch when token-file is absent", () => {
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        cfg: { channels: { googlechat: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          token: { client_email: "bot@example.com" },
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    });
  });
});
