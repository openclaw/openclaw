import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import {
  clearNextcloudTalkAccountFields,
  nextcloudTalkDmPolicy,
  nextcloudTalkSetupAdapter,
  normalizeNextcloudTalkBaseUrl,
  setNextcloudTalkAccountConfig,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

describe("nextcloud talk setup core", () => {
  it("normalizes and validates base urls", () => {
    expect(normalizeNextcloudTalkBaseUrl(" https://cloud.example.com/// ")).toBe(
      "https://cloud.example.com",
    );
    expect(normalizeNextcloudTalkBaseUrl(undefined)).toBe("");

    expect(validateNextcloudTalkBaseUrl("")).toBe("Required");
    expect(validateNextcloudTalkBaseUrl("cloud.example.com")).toBe(
      "URL must start with http:// or https://",
    );
    expect(validateNextcloudTalkBaseUrl("https://cloud.example.com")).toBeUndefined();
  });

  it("patches scoped account config and clears selected fields", () => {
    const cfg: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "top-secret",
          accounts: {
            work: {
              botSecret: "work-secret",
              botSecretFile: "/tmp/work-secret",
              apiPassword: "api-secret",
            },
          },
        },
      },
    };

    expect(
      setNextcloudTalkAccountConfig(cfg, DEFAULT_ACCOUNT_ID, {
        apiUser: "bot",
      }),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          apiUser: "bot",
        },
      },
    });

    expect(
      clearNextcloudTalkAccountFields(cfg, DEFAULT_ACCOUNT_ID, ["botSecret"]),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
        },
      },
    });
    expect(
      clearNextcloudTalkAccountFields(cfg, DEFAULT_ACCOUNT_ID, ["botSecret"]),
    ).not.toMatchObject({
      channels: {
        "nextcloud-talk": {
          botSecret: expect.anything(),
        },
      },
    });

    expect(clearNextcloudTalkAccountFields(cfg, "work", ["botSecret", "botSecretFile"]))
      .toMatchObject({
        channels: {
          "nextcloud-talk": {
            accounts: {
              work: {
                apiPassword: "api-secret",
              },
            },
          },
        },
      });
  });

  it("sets top-level DM policy state", async () => {
    const base: CoreConfig = {
      channels: {
        "nextcloud-talk": {},
      },
    };

    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("pairing");
    expect(nextcloudTalkDmPolicy.setPolicy(base, "open")).toMatchObject({
      channels: {
        "nextcloud-talk": {
          dmPolicy: "open",
        },
      },
    });
  });

  it("validates env/default-account constraints and applies config patches", () => {
    expect(
      nextcloudTalkSetupAdapter.validateInput({
        accountId: "work",
        input: { useEnv: true },
      } as never),
    ).toBe("NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.");

    expect(
      nextcloudTalkSetupAdapter.validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, baseUrl: "", secret: "" },
      } as never),
    ).toBe("Nextcloud Talk requires bot secret or --secret-file (or --use-env).");

    expect(
      nextcloudTalkSetupAdapter.validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, secret: "secret", baseUrl: "" },
      } as never),
    ).toBe("Nextcloud Talk requires --base-url.");

    expect(
      nextcloudTalkSetupAdapter.applyAccountConfig({
        cfg: {
          channels: {
            "nextcloud-talk": {},
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          baseUrl: "https://cloud.example.com///",
          secret: "bot-secret",
        },
      } as never),
    ).toEqual({
      channels: {
        "nextcloud-talk": {
          enabled: true,
          name: "Default",
          baseUrl: "https://cloud.example.com",
          botSecret: "bot-secret",
        },
      },
    });

    expect(
      nextcloudTalkSetupAdapter.applyAccountConfig({
        cfg: {
          channels: {
            "nextcloud-talk": {
              accounts: {
                work: {
                  botSecret: "old-secret",
                },
              },
            },
          },
        },
        accountId: "work",
        input: {
          name: "Work",
          useEnv: true,
          baseUrl: "https://cloud.example.com",
        },
      } as never),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              enabled: true,
              name: "Work",
              baseUrl: "https://cloud.example.com",
            },
          },
        },
      },
    });
  });
});
