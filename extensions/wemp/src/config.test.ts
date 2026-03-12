import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveWempAccount,
  validateResolvedWempAccount,
  validateWempChannelConfig,
} from "./config.js";

async function loadConfigWithFallbackValidator() {
  vi.resetModules();
  vi.doMock("node:module", async () => {
    const actual = await vi.importActual<typeof import("node:module")>("node:module");
    return {
      ...actual,
      createRequire: () =>
        ((id: string) => {
          if (id === "ajv") {
            throw new Error("ajv unavailable for fallback validator test");
          }
          return actual.createRequire(import.meta.url)(id);
        }) as any,
    };
  });
  return import("./config.js");
}

describe("wemp config", () => {
  it("resolveWempAccount applies defaults for routing and features", () => {
    const resolved = resolveWempAccount({
      channels: {
        wemp: {
          enabled: true,
          appId: "app-x",
          appSecret: "secret-x",
          token: "token-x",
        },
      },
    });

    expect(resolved.configured).toBe(true);
    expect(resolved.routing.pairedAgent).toBe("main");
    expect(resolved.routing.unpairedAgent).toBe("wemp-kf");
    expect(resolved.features.menu.enabled).toBe(false);
    expect(resolved.features.assistantToggle.enabled).toBe(false);
    expect(resolved.features.usageLimit.enabled).toBe(false);
  });

  it("resolveWempAccount supports account-level overrides", () => {
    const resolved = resolveWempAccount(
      {
        channels: {
          wemp: {
            enabled: true,
            appId: "app-root",
            appSecret: "secret-root",
            token: "token-root",
            routing: {
              pairedAgent: "main",
              unpairedAgent: "wemp-kf",
            },
            accounts: {
              brandA: {
                appId: "app-a",
                appSecret: "secret-a",
                token: "token-a",
                routing: {
                  pairedAgent: "agent-a",
                  unpairedAgent: "kf-a",
                },
              },
            },
          },
        },
      },
      "brandA",
    );

    expect(resolved.accountId).toBe("brandA");
    expect(resolved.appId).toBe("app-a");
    expect(resolved.routing.pairedAgent).toBe("agent-a");
    expect(resolved.routing.unpairedAgent).toBe("kf-a");
  });

  it("validateWempChannelConfig accepts voiceTranscribe endpoint in account config", () => {
    const issues = validateWempChannelConfig({
      channels: {
        wemp: {
          enabled: true,
          accounts: {
            brandA: {
              appId: "app-a",
              appSecret: "secret-a",
              token: "token-a",
              voiceTranscribe: {
                endpoint: "https://transcribe.example.com/hook",
              },
            },
          },
        },
      },
    });

    expect(issues).toHaveLength(0);
  });

  it("validateResolvedWempAccount includes account context and fix hints for missing fields", () => {
    const resolved = resolveWempAccount(
      {
        channels: {
          wemp: {
            enabled: true,
            accounts: {
              brandA: {
                enabled: true,
              },
            },
          },
        },
      },
      "brandA",
    );

    const issues = validateResolvedWempAccount(resolved);
    const appIdIssue = issues.find((item) => item.includes("appId missing"));
    expect(appIdIssue).toBeTruthy();
    expect(appIdIssue).toContain("accountId=brandA");
    expect(appIdIssue).toContain("field=appId");
    expect(appIdIssue).toContain("channels.wemp.accounts.brandA.appId");
    expect(appIdIssue).toContain("channels.wemp.appId");
  });

  it("validateResolvedWempAccount catches invalid webhookPath and aes key length", () => {
    const resolved = resolveWempAccount({
      channels: {
        wemp: {
          enabled: true,
          appId: "app-x",
          appSecret: "secret-x",
          token: "token-x",
          webhookPath: "invalid-path",
          encodingAESKey: "short",
        },
      },
    });
    const issues = validateResolvedWempAccount(resolved);
    const webhookIssue = issues.find((item) => item.includes("webhookPath must start with '/'"));
    expect(webhookIssue).toBeTruthy();
    expect(webhookIssue).toContain("accountId=default");
    expect(webhookIssue).toContain("field=webhookPath");
    expect(webhookIssue).toContain("current=invalid-path");
    expect(webhookIssue).toContain("channels.wemp.webhookPath");

    const aesIssue = issues.find((item) => item.includes("encodingAESKey should be 43 chars"));
    expect(aesIssue).toBeTruthy();
    expect(aesIssue).toContain("accountId=default");
    expect(aesIssue).toContain("field=encodingAESKey");
    expect(aesIssue).toContain("currentLength=5");
    expect(aesIssue).toContain("channels.wemp.encodingAESKey");
    expect(resolved.configured).toBe(false);
  });

  it("validateWempChannelConfig catches webhook path conflicts", () => {
    const issues = validateWempChannelConfig({
      channels: {
        wemp: {
          enabled: true,
          appId: "app-root",
          appSecret: "secret-root",
          token: "token-root",
          webhookPath: "/wemp",
          accounts: {
            a1: {
              appId: "a1",
              appSecret: "s1",
              token: "t1",
              webhookPath: "/same",
            },
            a2: {
              appId: "a2",
              appSecret: "s2",
              token: "t2",
              webhookPath: "/same",
            },
          },
        },
      },
    });
    const conflictIssue = issues.find((item) => item.includes("webhookPath conflict"));
    expect(conflictIssue).toBeTruthy();
    expect(conflictIssue).toContain("accountIds=a1,a2");
    expect(conflictIssue).toContain("field=webhookPath");
    expect(conflictIssue).toContain("channels.wemp.accounts.a1.webhookPath");
    expect(conflictIssue).toContain("channels.wemp.accounts.a2.webhookPath");
  });

  it("validateWempChannelConfig reports schema type errors with fix hints", () => {
    const issues = validateWempChannelConfig({
      channels: {
        wemp: {
          enabled: true,
          appId: "app",
          appSecret: "secret",
          token: 123 as any,
        } as any,
      },
    });
    const typeIssue = issues.find((item) => item.includes("schema must be string"));
    expect(typeIssue).toBeTruthy();
    expect(typeIssue).toContain("field=channels.wemp.token");
    expect(typeIssue).toContain("set channels.wemp.token as string");
  });

  it("validateWempChannelConfig reports unsupported fields with fix hints", () => {
    const issues = validateWempChannelConfig({
      channels: {
        wemp: {
          enabled: true,
          appId: "app",
          appSecret: "secret",
          token: "token",
          unknownFlag: true,
        } as any,
      },
    });
    const extraIssue = issues.find((item) =>
      item.includes("schema must NOT have additional properties"),
    );
    expect(extraIssue).toBeTruthy();
    expect(extraIssue).toContain("field=channels.wemp.unknownFlag");
    expect(extraIssue).toContain("remove unsupported field channels.wemp.unknownFlag");
  });
});

describe("wemp config fallback schema validator", () => {
  afterEach(() => {
    vi.unmock("node:module");
    vi.resetModules();
  });

  it("reports required errors for menu items", async () => {
    const { validateWempChannelConfig: validateWithFallback } =
      await loadConfigWithFallbackValidator();
    const issues = validateWithFallback({
      channels: {
        wemp: {
          enabled: true,
          appId: "app",
          appSecret: "secret",
          token: "token",
          features: {
            menu: {
              enabled: true,
              items: [{ name: "菜单项缺 type" } as any],
            },
          },
        } as any,
      },
    });

    const requiredIssue = issues.find((item) =>
      item.includes("schema must have required property 'type'"),
    );
    expect(requiredIssue).toBeTruthy();
    expect(requiredIssue).toContain("field=channels.wemp.features.menu.items.0.type");
    expect(requiredIssue).toContain("set channels.wemp.features.menu.items.0.type");
  });

  it("reports enum errors for invalid dm.policy", async () => {
    const { validateWempChannelConfig: validateWithFallback } =
      await loadConfigWithFallbackValidator();
    const issues = validateWithFallback({
      channels: {
        wemp: {
          enabled: true,
          appId: "app",
          appSecret: "secret",
          token: "token",
          dm: {
            policy: "everyone",
          },
        } as any,
      },
    });

    const enumIssue = issues.find((item) =>
      item.includes("schema must be equal to one of the allowed values"),
    );
    expect(enumIssue).toBeTruthy();
    expect(enumIssue).toContain("field=channels.wemp.dm.policy");
    expect(enumIssue).toContain("set channels.wemp.dm.policy to one of allowed values");
  });

  it("reports nested additionalProperties errors in accounts schema", async () => {
    const { validateWempChannelConfig: validateWithFallback } =
      await loadConfigWithFallbackValidator();
    const issues = validateWithFallback({
      channels: {
        wemp: {
          enabled: true,
          appId: "app",
          appSecret: "secret",
          token: "token",
          accounts: {
            branda: {
              appId: "app-a",
              appSecret: "secret-a",
              token: "token-a",
              routing: {
                pairedAgent: "main",
                unpairedAgent: "wemp-kf",
                extraRoute: "unsupported",
              },
            } as any,
          },
        } as any,
      },
    });

    const nestedExtraIssue = issues.find((item) =>
      item.includes("channels.wemp.accounts.branda.routing.extraRoute"),
    );
    expect(nestedExtraIssue).toBeTruthy();
    expect(nestedExtraIssue).toContain("schema must NOT have additional properties");
    expect(nestedExtraIssue).toContain(
      "remove unsupported field channels.wemp.accounts.branda.routing.extraRoute",
    );
  });
});
