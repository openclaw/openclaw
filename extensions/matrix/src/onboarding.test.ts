import { afterEach, describe, expect, it, vi } from "vitest";
import { createNonExitingTypedRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import type { RuntimeEnv, WizardPrompter } from "../runtime-api.js";
import { matrixOnboardingAdapter } from "./onboarding.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

vi.mock("./matrix/deps.js", () => ({
  ensureMatrixSdkInstalled: vi.fn(async () => {}),
  isMatrixSdkAvailable: vi.fn(() => true),
}));

describe("matrix onboarding", () => {
  const previousEnv = {
    MATRIX_HOMESERVER: process.env.MATRIX_HOMESERVER,
    MATRIX_USER_ID: process.env.MATRIX_USER_ID,
    MATRIX_ACCESS_TOKEN: process.env.MATRIX_ACCESS_TOKEN,
    MATRIX_PASSWORD: process.env.MATRIX_PASSWORD,
    MATRIX_DEVICE_ID: process.env.MATRIX_DEVICE_ID,
    MATRIX_DEVICE_NAME: process.env.MATRIX_DEVICE_NAME,
    MATRIX_OPS_HOMESERVER: process.env.MATRIX_OPS_HOMESERVER,
    MATRIX_OPS_ACCESS_TOKEN: process.env.MATRIX_OPS_ACCESS_TOKEN,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("offers env shortcut for non-default account when scoped env vars are present", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_HOMESERVER = "https://matrix.env.example.org";
    process.env.MATRIX_USER_ID = "@env:example.org";
    process.env.MATRIX_PASSWORD = "env-password"; // pragma: allowlist secret
    process.env.MATRIX_ACCESS_TOKEN = "";
    process.env.MATRIX_OPS_HOMESERVER = "https://matrix.ops.env.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";

    const confirmMessages: string[] = [];
    const prompter = {
      note: vi.fn(async () => {}),
      select: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix already configured. What do you want to do?") {
          return "add-account";
        }
        if (message === "Matrix auth method") {
          return "token";
        }
        throw new Error(`unexpected select prompt: ${message}`);
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix account name") {
          return "ops";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      }),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        confirmMessages.push(message);
        if (message.startsWith("Matrix env vars detected")) {
          return true;
        }
        return false;
      }),
    } as unknown as WizardPrompter;

    const result = await matrixOnboardingAdapter.configureInteractive!({
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
      runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
      prompter,
      options: undefined,
      accountOverrides: {},
      shouldPromptAccountIds: true,
      forceAllowFrom: false,
      configured: true,
      label: "Matrix",
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

    const prompter = {
      note: vi.fn(async () => {}),
      select: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix already configured. What do you want to do?") {
          return "add-account";
        }
        if (message === "Matrix auth method") {
          return "token";
        }
        throw new Error(`unexpected select prompt: ${message}`);
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix account name") {
          return "ops";
        }
        if (message === "Matrix homeserver URL") {
          return "https://matrix.ops.example.org";
        }
        if (message === "Matrix access token") {
          return "ops-token";
        }
        if (message === "Matrix device name (optional)") {
          return "";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      }),
      confirm: vi.fn(async () => false),
    } as unknown as WizardPrompter;

    const result = await matrixOnboardingAdapter.configureInteractive!({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.main.example.org",
            userId: "@main:example.org",
            accessToken: "main-token",
          },
        },
      } as CoreConfig,
      runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
      prompter,
      options: undefined,
      accountOverrides: {},
      shouldPromptAccountIds: true,
      forceAllowFrom: false,
      configured: true,
      label: "Matrix",
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
    const prompter = {
      note: vi.fn(async (message: unknown) => {
        notes.push(String(message));
      }),
      text: vi.fn(async () => {
        throw new Error("stop-after-help");
      }),
      confirm: vi.fn(async () => false),
      select: vi.fn(async () => "token"),
    } as unknown as WizardPrompter;

    await expect(
      matrixOnboardingAdapter.configureInteractive!({
        cfg: { channels: {} } as CoreConfig,
        runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
        prompter,
        options: undefined,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
        configured: false,
        label: "Matrix",
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

    const prompter = {
      note: vi.fn(async () => {}),
      select: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix auth method") {
          return "token";
        }
        throw new Error(`unexpected select prompt: ${message}`);
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix homeserver URL") {
          return "http://localhost.localdomain:8008";
        }
        if (message === "Matrix access token") {
          return "ops-token";
        }
        if (message === "Matrix device name (optional)") {
          return "";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      }),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Allow private/internal Matrix homeserver traffic for this account?") {
          return true;
        }
        if (message === "Enable end-to-end encryption (E2EE)?") {
          return false;
        }
        return false;
      }),
    } as unknown as WizardPrompter;

    const result = await matrixOnboardingAdapter.configureInteractive!({
      cfg: {} as CoreConfig,
      runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
      prompter,
      options: undefined,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
      configured: false,
      label: "Matrix",
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

    const prompter = {
      note: vi.fn(async () => {}),
      select: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix already configured. What do you want to do?") {
          return "add-account";
        }
        if (message === "Matrix auth method") {
          return "token";
        }
        if (message === "Matrix rooms access") {
          return "allowlist";
        }
        throw new Error(`unexpected select prompt: ${message}`);
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix account name") {
          return "ops";
        }
        if (message === "Matrix homeserver URL") {
          return "https://matrix.ops.example.org";
        }
        if (message === "Matrix access token") {
          return "ops-token";
        }
        if (message === "Matrix device name (optional)") {
          return "Ops Gateway";
        }
        if (message === "Matrix allowFrom (full @user:server; display name only if unique)") {
          return "@alice:example.org";
        }
        if (message === "Matrix rooms allowlist (comma-separated)") {
          return "!ops-room:example.org";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      }),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enable end-to-end encryption (E2EE)?") {
          return false;
        }
        if (message === "Configure Matrix rooms access?") {
          return true;
        }
        return false;
      }),
    } as unknown as WizardPrompter;

    const result = await matrixOnboardingAdapter.configureInteractive!({
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
      runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
      prompter,
      options: undefined,
      accountOverrides: {},
      shouldPromptAccountIds: true,
      forceAllowFrom: true,
      configured: true,
      label: "Matrix",
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
        "!ops-room:example.org": { allow: true },
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
