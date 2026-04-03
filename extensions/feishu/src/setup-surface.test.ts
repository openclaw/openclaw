import { describe, expect, it, vi } from "vitest";
import { createNonExitingTypedRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
  type WizardPrompter,
} from "../../../test/helpers/plugins/setup-wizard.js";

vi.mock("./probe.js", () => ({
  probeFeishu: vi.fn(async () => ({ ok: false, error: "mocked" })),
}));

import { feishuPlugin } from "./channel.js";

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
  return await feishuGetStatus({
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

const feishuConfigure = createPluginSetupWizardConfigure(feishuPlugin);
const feishuGetStatus = createPluginSetupWizardStatus(feishuPlugin);
type FeishuConfigureRuntime = Parameters<typeof feishuConfigure>[0]["runtime"];

describe("feishu setup wizard", () => {
  it("setup adapter preserves a selected named account id", () => {
    expect(
      feishuPlugin.setup?.resolveAccountId?.({
        cfg: {} as never,
        accountId: "work",
        input: {},
      } as never),
    ).toBe("work");
  });

  it("setup adapter uses configured defaultAccount when accountId is omitted", () => {
    expect(
      feishuPlugin.setup?.resolveAccountId?.({
        cfg: {
          channels: {
            feishu: {
              defaultAccount: "work",
              accounts: {
                work: {
                  appId: "work-app",
                  appSecret: "work-secret", // pragma: allowlist secret
                },
              },
            },
          },
        } as never,
        accountId: undefined,
        input: {},
      } as never),
    ).toBe("work");
  });

  it("does not throw when config appId/appSecret are SecretRef objects", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt")
      .mockResolvedValueOnce("oc_group_1");
    const prompter = createTestWizardPrompter({
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "allowlist",
      ) as never,
    });

    await expect(
      runSetupWizardConfigure({
        configure: feishuConfigure,
        cfg: {
          channels: {
            feishu: {
              appId: { source: "env", id: "FEISHU_APP_ID", provider: "default" },
              appSecret: { source: "env", id: "FEISHU_APP_SECRET", provider: "default" },
            },
          },
        } as never,
        prompter,
        runtime: createNonExitingTypedRuntimeEnv<FeishuConfigureRuntime>(),
      }),
    ).resolves.toBeTruthy();
  });

  it("writes selected-account credentials instead of overwriting the channel root", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Feishu App Secret") {
          return "work-secret"; // pragma: allowlist secret
        }
        if (message === "Enter Feishu App ID") {
          return "work-app";
        }
        if (message === "Group chat allowlist (chat_ids)") {
          return "";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "websocket",
      ) as never,
    });

    const result = await runSetupWizardConfigure({
      configure: feishuConfigure,
      cfg: {
        channels: {
          feishu: {
            appId: "top-level-app",
            appSecret: "top-level-secret", // pragma: allowlist secret
            accounts: {
              work: {
                appId: "",
              },
            },
          },
        },
      } as never,
      prompter,
      accountOverrides: {
        feishu: "work",
      },
      runtime: createNonExitingTypedRuntimeEnv<FeishuConfigureRuntime>(),
    });

    expect(result.cfg.channels?.feishu?.appId).toBe("top-level-app");
    expect(result.cfg.channels?.feishu?.appSecret).toBe("top-level-secret");
    expect(result.cfg.channels?.feishu?.accounts?.work).toMatchObject({
      enabled: true,
      appId: "work-app",
      appSecret: "work-secret",
    });
  });

  it("uses configured defaultAccount for omitted finalize writes", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Feishu App Secret") {
          return "work-secret"; // pragma: allowlist secret
        }
        if (message === "Enter Feishu App ID") {
          return "work-app";
        }
        if (message === "Feishu webhook path") {
          return "/feishu/events";
        }
        if (message === "Group chat allowlist (chat_ids)") {
          return "";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      select: vi.fn(
        async ({ message, initialValue }: { message: string; initialValue?: string }) => {
          if (message === "Feishu connection mode") {
            return initialValue ?? "websocket";
          }
          if (message === "Which Feishu domain?") {
            return initialValue ?? "feishu";
          }
          if (message === "Group chat policy") {
            return "disabled";
          }
          return initialValue ?? "websocket";
        },
      ) as never,
      note: vi.fn(async () => {}),
    });

    const result = await runSetupWizardFinalize({
      finalize:
        feishuPlugin.setupWizard && "finalize" in feishuPlugin.setupWizard
          ? feishuPlugin.setupWizard.finalize
          : undefined,
      cfg: {
        channels: {
          feishu: {
            appId: "top-level-app",
            appSecret: "top-level-secret", // pragma: allowlist secret
            defaultAccount: "work",
            accounts: {
              work: {
                appId: "",
              },
            },
          },
        },
      } as never,
      accountId: undefined as never,
      prompter,
      runtime: createNonExitingTypedRuntimeEnv<FeishuConfigureRuntime>(),
      options: {},
    });

    expect(result).toBeDefined();
    expect(result?.cfg).toBeDefined();
    const nextCfg = result!.cfg!;
    expect(nextCfg.channels?.feishu?.appId).toBe("top-level-app");
    expect(nextCfg.channels?.feishu?.appSecret).toBe("top-level-secret");
    expect(nextCfg.channels?.feishu?.accounts?.work).toMatchObject({
      enabled: true,
      appId: "work-app",
      appSecret: "work-secret",
    });
  });
});

describe("feishu setup wizard status", () => {
  it("treats SecretRef appSecret as configured when appId is present", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "cli_a123456",
            appSecret: {
              source: "env",
              provider: "default",
              id: "FEISHU_APP_SECRET",
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "top_level_app",
            accounts: {
              main: {
                appId: "",
                appSecret: "sample-app-credential", // pragma: allowlist secret
              },
            },
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(false);
  });

  it("setup status honors the selected named account", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "top_level_app",
            appSecret: "top-level-secret", // pragma: allowlist secret
            accounts: {
              work: {
                appId: "",
                appSecret: "work-secret", // pragma: allowlist secret
              },
            },
          },
        },
      } as never,
      accountOverrides: {
        feishu: "work",
      },
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["Feishu: needs app credentials"]);
  });

  it("uses configured defaultAccount for omitted DM policy account context", async () => {
    const { feishuSetupWizard } = await import("./setup-surface.js");
    const cfg = {
      channels: {
        feishu: {
          allowFrom: ["ou_root"],
          defaultAccount: "work",
          accounts: {
            work: {
              appId: "work-app",
              appSecret: "work-secret", // pragma: allowlist secret
              dmPolicy: "allowlist",
              allowFrom: ["ou_work"],
            },
          },
        },
      },
    } as const;

    expect(feishuSetupWizard.dmPolicy?.getCurrent?.(cfg as never)).toBe("allowlist");
    expect(feishuSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg as never)).toEqual({
      policyKey: "channels.feishu.accounts.work.dmPolicy",
      allowFromKey: "channels.feishu.accounts.work.allowFrom",
    });

    const next = feishuSetupWizard.dmPolicy?.setPolicy?.(cfg as never, "open");

    expect(next?.channels?.feishu?.dmPolicy).toBeUndefined();
    expect(next?.channels?.feishu?.allowFrom).toEqual(["ou_root"]);
    expect(next?.channels?.feishu?.accounts?.work?.dmPolicy).toBe("open");
    expect(next?.channels?.feishu?.accounts?.work?.allowFrom).toEqual(["ou_work", "*"]);
  });

  it("treats env SecretRef appId as not configured when env var is missing", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_MISSING_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_MISSING_TEST"; // pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: undefined,
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(false);
      },
    );
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_TEST"; // pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(true);
      },
    );
  });
});
