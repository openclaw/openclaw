import { describe, expect, it, vi } from "vitest";

vi.mock("./probe.js", () => ({
  probeFeishu: vi.fn(async () => ({ ok: false, error: "mocked" })),
}));

import { feishuOnboardingAdapter } from "./onboarding.js";

const baseConfigureContext = {
  runtime: {} as never,
  accountOverrides: {},
  shouldPromptAccountIds: false,
  forceAllowFrom: false,
};

const baseStatusContext = {
  accountOverrides: {},
};

describe("feishuOnboardingAdapter.configure", () => {
  it("does not throw when config appId/appSecret are SecretRef objects", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt")
      .mockResolvedValueOnce("oc_group_1");

    const prompter = {
      note: vi.fn(async () => undefined),
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "allowlist",
      ),
    } as never;

    await expect(
      feishuOnboardingAdapter.configure({
        cfg: {
          channels: {
            feishu: {
              appId: { source: "env", id: "FEISHU_APP_ID", provider: "default" },
              appSecret: { source: "env", id: "FEISHU_APP_SECRET", provider: "default" },
            },
          },
        } as never,
        prompter,
        ...baseConfigureContext,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("feishuOnboardingAdapter.getStatus", () => {
  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    const status = await feishuOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "top_level_app",
            accounts: {
              main: {
                appId: "",
                appSecret: "secret_123",
              },
            },
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(false);
  });

  it("treats env SecretRef appId as not configured when env var is missing", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_MISSING_TEST";
    const appSecretKey = "FEISHU_APP_SECRET_STATUS_MISSING_TEST";
    const prevAppId = process.env[appIdKey];
    const prevAppSecret = process.env[appSecretKey];
    delete process.env[appIdKey];
    process.env[appSecretKey] = "secret_env_456";

    try {
      const status = await feishuOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            feishu: {
              appId: { source: "env", id: appIdKey, provider: "default" },
              appSecret: { source: "env", id: appSecretKey, provider: "default" },
            },
          },
        } as never,
        ...baseStatusContext,
      });

      expect(status.configured).toBe(false);
    } finally {
      if (prevAppId === undefined) {
        delete process.env[appIdKey];
      } else {
        process.env[appIdKey] = prevAppId;
      }
      if (prevAppSecret === undefined) {
        delete process.env[appSecretKey];
      } else {
        process.env[appSecretKey] = prevAppSecret;
      }
    }
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_SECRET_STATUS_TEST";
    const prevAppId = process.env[appIdKey];
    const prevAppSecret = process.env[appSecretKey];
    process.env[appIdKey] = "cli_env_123";
    process.env[appSecretKey] = "secret_env_456";

    try {
      const status = await feishuOnboardingAdapter.getStatus({
        cfg: {
          channels: {
            feishu: {
              appId: { source: "env", id: appIdKey, provider: "default" },
              appSecret: { source: "env", id: appSecretKey, provider: "default" },
            },
          },
        } as never,
        ...baseStatusContext,
      });

      expect(status.configured).toBe(true);
    } finally {
      if (prevAppId === undefined) {
        delete process.env[appIdKey];
      } else {
        process.env[appIdKey] = prevAppId;
      }
      if (prevAppSecret === undefined) {
        delete process.env[appSecretKey];
      } else {
        process.env[appSecretKey] = prevAppSecret;
      }
    }
  });
});
