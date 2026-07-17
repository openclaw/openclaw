// Clickclack tests cover accounts plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveClickClackRuntimeAccount,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

function writeExecResolver(filePath: string, values: Record<string, string>) {
  fs.writeFileSync(
    filePath,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ protocolVersion: 1, values })}'\n`,
    "utf8",
  );
  fs.chmodSync(filePath, 0o700);
}

describe("ClickClack account resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "test-token-placeholder",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("default");
    expect(resolveClickClackAccount({ cfg }).token).toBe("test-token-placeholder");
  });

  it("does not synthesize a partial top-level default account from inherited credentials", () => {
    const cfg = {
      channels: {
        clickclack: {
          token: "test-auth-token",
          accounts: {
            work: {
              baseUrl: "https://app.clickclack.chat",
              workspace: "wsp_1",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("does not synthesize a default account from blank top-level credentials", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_default",
          token: "   ",
          accounts: {
            work: {
              baseUrl: "https://app.clickclack.chat",
              workspace: "wsp_1",
              token: "gateway-token",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("resolves env SecretRefs at runtime", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            service: {
              token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(
      resolveClickClackAccount({
        cfg,
        accountId: "service",
        env: { CLICKCLACK_SERVICE_TOKEN: "  test-token-placeholder  " },
      }),
    ).toEqual({
      allowFrom: ["*"],
      accountId: "service",
      baseUrl: "https://app.clickclack.chat",
      config: {
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
        workspace: "wsp_1",
      },
      configured: true,
      agentId: undefined,
      botUserId: undefined,
      defaultTo: "channel:general",
      enabled: true,
      agentActivity: false,
      commandMenu: true,
      model: undefined,
      name: undefined,
      reconnectMs: 1_500,
      replyMode: "agent",
      systemPrompt: undefined,
      token: "test-token-placeholder",
      timeoutSeconds: undefined,
      toolsAllow: undefined,
      workspace: "wsp_1",
    });
  });

  it("treats configured exec SecretRefs as configured without exposing tokens in inspect snapshots", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: { source: "exec", provider: "example_exec", id: "CLICKCLACK_SERVICE_TOKEN" },
        },
      },
      secrets: {
        providers: {
          example_exec: {
            source: "exec",
            command: "/not-run-during-inspection",
            jsonOnly: true,
            allowInsecurePath: true,
          },
        },
      },
    } satisfies CoreConfig;

    const account = resolveClickClackAccount({ cfg });

    expect(account.configured).toBe(true);
    expect(account.token).toBe("");
  });

  it("resolves file and exec SecretRefs for runtime account tokens", async () => {
    await withTempDir("clickclack-secretref-", async (tempDir) => {
      const secretFile = path.join(tempDir, "clickclack-token");
      fs.writeFileSync(secretFile, "  file-token-placeholder  \n", "utf8");
      fs.chmodSync(secretFile, 0o600);
      const execResolver = path.join(tempDir, "resolve-clickclack-token");
      writeExecResolver(execResolver, {
        CLICKCLACK_SERVICE_TOKEN: "  exec-token-placeholder  ",
      });
      const cfg = {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "https://app.clickclack.chat",
            workspace: "wsp_1",
            accounts: {
              file: {
                token: { source: "file", provider: "clickclack_file", id: "value" },
              },
              exec: {
                token: {
                  source: "exec",
                  provider: "clickclack_exec",
                  id: "CLICKCLACK_SERVICE_TOKEN",
                },
              },
            },
          },
        },
        secrets: {
          providers: {
            clickclack_file: { source: "file", path: secretFile, mode: "singleValue" },
            clickclack_exec: { source: "exec", command: execResolver, jsonOnly: true },
          },
        },
      } satisfies CoreConfig;

      await expect(
        resolveClickClackRuntimeAccount({ cfg, accountId: "file" }),
      ).resolves.toMatchObject({
        configured: true,
        token: "file-token-placeholder",
      });
      await expect(
        resolveClickClackRuntimeAccount({ cfg, accountId: "exec" }),
      ).resolves.toMatchObject({
        configured: true,
        token: "exec-token-placeholder",
      });
    });
  });

  it("uses the default ClickClack env token only for the default account", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            work: {},
          },
        },
      },
    } satisfies CoreConfig;
    const env = { CLICKCLACK_BOT_TOKEN: "  default-env-token  " };
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", env.CLICKCLACK_BOT_TOKEN);

    expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveClickClackAccount({ cfg, env }).token).toBe("default-env-token");
    expect(resolveClickClackAccount({ cfg, accountId: "work", env }).token).toBe("");
  });

  it("reads tokenFile credentials without overriding a named account token", async () => {
    await withTempDir("clickclack-token-", async (tempDir) => {
      const tokenFile = path.join(tempDir, "token");
      fs.writeFileSync(tokenFile, "  file-token  \n", "utf8");
      const cfg = {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "https://app.clickclack.chat",
            workspace: "wsp_1",
            tokenFile,
            accounts: {
              work: {
                token: "work-token",
              },
            },
          },
        },
      } satisfies CoreConfig;

      expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
      expect(resolveClickClackAccount({ cfg }).token).toBe("file-token");
      expect(resolveClickClackAccount({ cfg, accountId: "work" }).token).toBe("work-token");
    });
  });

  it("resolves model-mode bot account policy", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            peter: {
              token: "token-oversized",
              agentId: "peter-bot",
              replyMode: "model",
              model: "openai/gpt-5.4-mini",
              toolsAllow: ["web_search"],
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg, accountId: "peter" })).toEqual({
      allowFrom: ["*"],
      accountId: "peter",
      agentId: "peter-bot",
      baseUrl: "https://app.clickclack.chat",
      config: {
        agentId: "peter-bot",
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        model: "openai/gpt-5.4-mini",
        replyMode: "model",
        token: "token-oversized",
        toolsAllow: ["web_search"],
        workspace: "wsp_1",
      },
      configured: true,
      botUserId: undefined,
      defaultTo: "channel:general",
      enabled: true,
      agentActivity: false,
      commandMenu: true,
      model: "openai/gpt-5.4-mini",
      name: undefined,
      reconnectMs: 1_500,
      replyMode: "model",
      systemPrompt: undefined,
      token: "token-oversized",
      timeoutSeconds: undefined,
      toolsAllow: ["web_search"],
      workspace: "wsp_1",
    });
  });

  it("resolves the agent activity opt-in only when explicitly enabled", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "test-token-placeholder",
          accounts: {
            bridge: {
              token: "clawrouter-e2e-secret",
              agentActivity: true,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).agentActivity).toBe(false);
    expect(resolveClickClackAccount({ cfg, accountId: "bridge" }).agentActivity).toBe(true);
  });

  it("enables command menus unless the resolved account explicitly disables them", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "test-token-placeholder",
          accounts: {
            disabled: {
              commandMenu: false,
            },
            enabled: {
              commandMenu: true,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).commandMenu).toBe(true);
    expect(resolveClickClackAccount({ cfg, accountId: "disabled" }).commandMenu).toBe(false);
    expect(resolveClickClackAccount({ cfg, accountId: "enabled" }).commandMenu).toBe(true);
  });

  it("normalizes reconnect intervals to the public config bounds", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          token: "very-long-browser-token-0123456789",
          workspace: "wsp_1",
          reconnectMs: 1,
          accounts: {
            slow: {
              reconnectMs: 1_000_000,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).reconnectMs).toBe(100);
    expect(resolveClickClackAccount({ cfg, accountId: "slow" }).reconnectMs).toBe(60_000);
  });
});
