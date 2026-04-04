import { describe, expect, it, vi } from "vitest";
import { matrixOnboardingAdapter } from "./onboarding.js";
import {
  installMatrixOnboardingEnvRestoreHooks,
  createMatrixWizardPrompter,
  runMatrixAddAccountAllowlistConfigure,
  runMatrixInteractiveConfigure,
} from "./onboarding.test-harness.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

vi.mock("./matrix/deps.js", () => ({
  ensureMatrixSdkInstalled: vi.fn(async () => {}),
  isMatrixSdkAvailable: vi.fn(() => true),
}));

describe("matrix onboarding", () => {
  installMatrixOnboardingEnvRestoreHooks();

  it("offers env shortcut for non-default account when scoped env vars are present", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_HOMESERVER = "https://matrix.env.example.org";
    process.env.MATRIX_USER_ID = "@env:example.org";
    process.env.MATRIX_PASSWORD = "env-password"; // pragma: allowlist secret
    process.env.MATRIX_ACCESS_TOKEN = "";
    process.env.MATRIX_OPS_HOMESERVER = "https://matrix.ops.env.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";

    const confirmMessages: string[] = [];
    const prompter = createMatrixWizardPrompter({
      select: {
        "Matrix already configured. What do you want to do?": "add-account",
        "Matrix auth method": "token",
      },
      text: {
        "Matrix account name": "ops",
      },
      onConfirm: (message) => {
        confirmMessages.push(message);
        return message.startsWith("Matrix env vars detected");
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.main.example.org",
                accessToken: "main-token",
              },
            },
          },
        },
      } as CoreConfig,
      prompter,
      shouldPromptAccountIds: true,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result !== "skip") {
      expect(result.accountId).toBe("ops");
      expect(result.cfg.channels?.["matrix"]?.accounts?.ops).toMatchObject({
        enabled: true,
      });
      expect(result.cfg.channels?.["matrix"]?.accounts?.ops?.homeserver).toBeUndefined();
      expect(result.cfg.channels?.["matrix"]?.accounts?.ops?.accessToken).toBeUndefined();
    }
    expect(
      confirmMessages.some((message) =>
        message.startsWith(
          "Matrix env vars detected (MATRIX_OPS_HOMESERVER (+ auth vars)). Use env values?",
        ),
      ),
    ).toBe(true);
  });

  it("promotes legacy top-level Matrix config before adding a named account", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixWizardPrompter({
      select: {
        "Matrix already configured. What do you want to do?": "add-account",
        "Matrix auth method": "token",
      },
      text: {
        "Matrix account name": "ops",
        "Matrix homeserver URL": "https://matrix.ops.example.org",
        "Matrix access token": "ops-token",
        "Matrix device name (optional)": "",
      },
      onConfirm: async () => false,
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.main.example.org",
            userId: "@main:example.org",
            accessToken: "main-token",
          },
        },
      } as CoreConfig,
      prompter,
      shouldPromptAccountIds: true,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.homeserver).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accessToken).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accounts?.default).toMatchObject({
      homeserver: "https://matrix.main.example.org",
      userId: "@main:example.org",
      accessToken: "main-token",
    });
    expect(result.cfg.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "ops",
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
    });
  });

  it("includes device env var names in auth help text", async () => {
    installMatrixTestRuntime();

    const notes: string[] = [];
    const prompter = createMatrixWizardPrompter({
      notes,
      onText: async () => {
        throw new Error("stop-after-help");
      },
      onConfirm: async () => false,
      onSelect: async () => "token",
    });

    await expect(
      runMatrixInteractiveConfigure({
        cfg: { channels: {} } as CoreConfig,
        prompter,
      }),
    ).rejects.toThrow("stop-after-help");

    const noteText = notes.join("\n");
    expect(noteText).toContain("MATRIX_DEVICE_ID");
    expect(noteText).toContain("MATRIX_DEVICE_NAME");
    expect(noteText).toContain("MATRIX_<ACCOUNT_ID>_DEVICE_ID");
    expect(noteText).toContain("MATRIX_<ACCOUNT_ID>_DEVICE_NAME");
  });

  it("prompts for private-network access when onboarding an internal http homeserver", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixWizardPrompter({
      select: {
        "Matrix auth method": "token",
      },
      text: {
        "Matrix homeserver URL": "http://localhost.localdomain:8008",
        "Matrix access token": "ops-token",
        "Matrix device name (optional)": "",
      },
      confirm: {
        "Allow private/internal Matrix homeserver traffic for this account?": true,
        "Enable end-to-end encryption (E2EE)?": false,
      },
      onConfirm: async () => false,
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {} as CoreConfig,
      prompter,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix).toMatchObject({
      homeserver: "http://localhost.localdomain:8008",
      allowPrivateNetwork: true,
      accessToken: "ops-token",
    });
  });

  it("preserves SecretRef access tokens when keeping existing credentials", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_ACCESS_TOKEN = "env-token";

    const prompter = createMatrixWizardPrompter({
      select: {
        "Matrix already configured. What do you want to do?": "update",
      },
      text: {
        "Matrix homeserver URL": "https://matrix.example.org",
        "Matrix device name (optional)": "OpenClaw Gateway",
      },
      confirm: {
        "Matrix credentials already configured. Keep them?": true,
        "Enable end-to-end encryption (E2EE)?": false,
        "Configure Matrix rooms access?": false,
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
          },
        },
        secrets: {
          defaults: {
            env: "default",
          },
        },
      } as CoreConfig,
      prompter,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.accessToken).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_ACCESS_TOKEN",
    });
  });

  it("resolves status using the overridden Matrix account", async () => {
    const status = await matrixOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          matrix: {
            defaultAccount: "default",
            accounts: {
              default: {
                homeserver: "https://matrix.default.example.org",
              },
              ops: {
                homeserver: "https://matrix.ops.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
      options: undefined,
      accountOverrides: {
        matrix: "ops",
      },
    });

    expect(status.configured).toBe(true);
    expect(status.selectionHint).toBe("configured");
    expect(status.statusLines).toEqual(["Matrix: configured"]);
  });

  it("writes allowlists and room access to the selected Matrix account", async () => {
    installMatrixTestRuntime();

    const result = await runMatrixAddAccountAllowlistConfigure({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.main.example.org",
                accessToken: "main-token",
              },
            },
          },
        },
      } as CoreConfig,
      allowFromInput: "@alice:example.org",
      roomsAllowlistInput: "!ops-room:example.org",
      deviceName: "Ops Gateway",
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.accountId).toBe("ops");
    expect(result.cfg.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
      deviceName: "Ops Gateway",
      dm: {
        policy: "allowlist",
        allowFrom: ["@alice:example.org"],
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
    });
    expect(result.cfg.channels?.["matrix"]?.dm).toBeUndefined();
    expect(result.cfg.channels?.["matrix"]?.groups).toBeUndefined();
  });

  it("reports account-scoped DM config keys for named accounts", () => {
    const resolveConfigKeys = matrixOnboardingAdapter.dmPolicy?.resolveConfigKeys;
    expect(resolveConfigKeys).toBeDefined();
    if (!resolveConfigKeys) {
      return;
    }

    expect(
      resolveConfigKeys(
        {
          channels: {
            matrix: {
              accounts: {
                default: {
                  homeserver: "https://matrix.main.example.org",
                },
                ops: {
                  homeserver: "https://matrix.ops.example.org",
                },
              },
            },
          },
        } as CoreConfig,
        "ops",
      ),
    ).toEqual({
      policyKey: "channels.matrix.accounts.ops.dm.policy",
      allowFromKey: "channels.matrix.accounts.ops.dm.allowFrom",
    });
  });

  it("reports configured when only the effective default Matrix account is configured", async () => {
    installMatrixTestRuntime();

    const status = await matrixOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          matrix: {
            defaultAccount: "ops",
            accounts: {
              ops: {
                homeserver: "https://matrix.ops.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toContain("Matrix: configured");
    expect(status.selectionHint).toBe("configured");
  });

  it("asks for defaultAccount when multiple named Matrix accounts exist", async () => {
    installMatrixTestRuntime();

    const status = await matrixOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                homeserver: "https://matrix.assistant.example.org",
                accessToken: "assistant-token",
              },
              ops: {
                homeserver: "https://matrix.ops.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual([
      'Matrix: set "channels.matrix.defaultAccount" to select a named account',
    ]);
    expect(status.selectionHint).toBe("set defaultAccount");
  });
});
