import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.config.resolveAllowFrom", () => {
  const makeCfg = (allowFrom?: unknown) =>
    ({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            test: { appId: "cli_test", appSecret: "secret", allowFrom },
          },
        },
      },
    }) as OpenClawConfig;

  it("returns [\"*\"] when allowFrom is the string \"*\"", () => {
    const result = feishuPlugin.config.resolveAllowFrom!({
      cfg: makeCfg("*"),
      accountId: "test",
    });
    expect(result).toEqual(["*"]);
  });

  it("returns mapped strings when allowFrom is an array", () => {
    const result = feishuPlugin.config.resolveAllowFrom!({
      cfg: makeCfg(["ou_abc", "ou_def"]),
      accountId: "test",
    });
    expect(result).toEqual(["ou_abc", "ou_def"]);
  });

  it("returns empty array when allowFrom is undefined", () => {
    const result = feishuPlugin.config.resolveAllowFrom!({
      cfg: makeCfg(undefined),
      accountId: "test",
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when allowFrom is a non-wildcard string", () => {
    const result = feishuPlugin.config.resolveAllowFrom!({
      cfg: makeCfg("ou_single"),
      accountId: "test",
    });
    expect(result).toEqual([]);
  });
});

describe("feishuPlugin.config.formatAllowFrom", () => {
  it("trims, lowercases, and filters empty entries", () => {
    const result = feishuPlugin.config.formatAllowFrom!({
      allowFrom: ["  OU_ABC  ", "", "ou_DEF"],
    });
    expect(result).toEqual(["ou_abc", "ou_def"]);
  });
});

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});
