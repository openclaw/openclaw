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

async function withEnvVars(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, prior] of previous.entries()) {
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

async function getStatusWithEnvRefs(params: { appIdKey: string; appSecretKey: string }) {
  return await feishuOnboardingAdapter.getStatus({
    cfg: {
      channels: {
        feishu: {
          appId: { source: "env", id: params.appIdKey, provider: "default" },
          appSecret: { source: "env", id: params.appSecretKey, provider: "default" },
        },
      },
    } as never,
    ...baseStatusContext,
  });
}

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
    await withEnvVars(
      {
        [appIdKey]: undefined,
        [appSecretKey]: "secret_env_456",
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(false);
      },
    );
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_SECRET_STATUS_TEST";
    await withEnvVars(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "secret_env_456",
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(true);
      },
    );
  });
});
