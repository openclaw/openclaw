import { describe, expect, it, vi } from "vitest";
vi.mock("./probe.js", () => ({
  probeFeishu: vi.fn(async () => ({ ok: false, error: "mocked" }))
}));
import { feishuOnboardingAdapter } from "./onboarding.js";
const baseConfigureContext = {
  runtime: {},
  accountOverrides: {},
  shouldPromptAccountIds: false,
  forceAllowFrom: false
};
const baseStatusContext = {
  accountOverrides: {}
};
async function withEnvVars(values, run) {
  const previous = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === void 0) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, prior] of previous.entries()) {
      if (prior === void 0) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}
async function getStatusWithEnvRefs(params) {
  return await feishuOnboardingAdapter.getStatus({
    cfg: {
      channels: {
        feishu: {
          appId: { source: "env", id: params.appIdKey, provider: "default" },
          appSecret: { source: "env", id: params.appSecretKey, provider: "default" }
        }
      }
    },
    ...baseStatusContext
  });
}
describe("feishuOnboardingAdapter.configure", () => {
  it("does not throw when config appId/appSecret are SecretRef objects", async () => {
    const text = vi.fn().mockResolvedValueOnce("cli_from_prompt").mockResolvedValueOnce("secret_from_prompt").mockResolvedValueOnce("oc_group_1");
    const prompter = {
      note: vi.fn(async () => void 0),
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }) => initialValue ?? "allowlist"
      )
    };
    await expect(
      feishuOnboardingAdapter.configure({
        cfg: {
          channels: {
            feishu: {
              appId: { source: "env", id: "FEISHU_APP_ID", provider: "default" },
              appSecret: { source: "env", id: "FEISHU_APP_SECRET", provider: "default" }
            }
          }
        },
        prompter,
        ...baseConfigureContext
      })
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
                appSecret: "sample-app-credential"
                // pragma: allowlist secret
              }
            }
          }
        }
      },
      ...baseStatusContext
    });
    expect(status.configured).toBe(false);
  });
  it("treats env SecretRef appId as not configured when env var is missing", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_MISSING_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_MISSING_TEST";
    await withEnvVars(
      {
        [appIdKey]: void 0,
        [appSecretKey]: "env-credential-456"
        // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(false);
      }
    );
  });
  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_TEST";
    await withEnvVars(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "env-credential-456"
        // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(true);
      }
    );
  });
});
