import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { signalPlugin } from "./channel.js";
import { signalDoctor } from "./doctor.js";
import { signalSetupAdapter } from "./setup-core.js";

const authored = {
  account: "+12025550124",
  transport: { kind: "external-native" as const, url: "http://127.0.0.1:19962" },
  replyToMode: "off" as const,
};

describe("Signal registered account entry points", () => {
  it.each([
    ["default", true],
    ["Default.", true],
    ["default", false],
    ["Default.", false],
  ] as const)(
    "channels.add setupContract preserves default %s winner when restoring its number (restricted=%s)",
    (key, restricted) => {
      const cfg: OpenClawConfig = {
        channels: {
          signal: {
            replyToMode: "all",
            dmPolicy: "open",
            allowFrom: ["*"],
            transport: { kind: "external-native", url: "http://127.0.0.1:19961" },
            accounts: {
              [key]: {
                account: "+12025550123",
                ...(restricted
                  ? {
                      enabled: false,
                      dmPolicy: "allowlist" as const,
                      allowFrom: ["+12025550126"],
                      replyToMode: "off" as const,
                    }
                  : {}),
              },
              "DEFAULT!": { account: "+12025550125", dmPolicy: "disabled" },
            },
          },
        },
      };
      const setup = expectDefined(signalPlugin.setupContract, "registered setup contract");
      const next = setup.applyAccountConfig({
        cfg,
        accountId: "work",
        input: {
          signalNumber: "+12025550124",
          signalTransport: "external-native",
          httpUrl: "http://127.0.0.1:19962",
        },
      });
      expect(signalPlugin.config.resolveAccount(next, "default")).toMatchObject({
        enabled: !restricted,
        config: {
          account: "+12025550123",
          replyToMode: restricted ? "off" : "all",
          dmPolicy: restricted ? "allowlist" : "open",
          allowFrom: restricted ? ["+12025550126"] : ["*"],
        },
      });
      expect(next.channels?.signal?.accounts?.["DEFAULT!"]).toEqual(
        cfg.channels?.signal?.accounts?.["DEFAULT!"],
      );
      expect(signalPlugin.config.resolveAccount(next, "work").config).toMatchObject({
        dmPolicy: "open",
        allowFrom: ["*"],
      });
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "Doctor normalizeCompatibilityConfig keeps the exact default transport (managed=%s, aliasFirst=%s)",
    async (managed, aliasFirst) => {
      const exact = {
        account: "+12025550124",
        ...(managed ? { httpPort: 18081 } : { httpUrl: "http://127.0.0.1:19962" }),
      };
      const alias = {
        account: "+12025550125",
        ...(managed ? { httpPort: 18081 } : { httpUrl: "http://127.0.0.1:19963" }),
      };
      const signal = {
        apiMode: "native",
        accounts: aliasFirst
          ? { "Default.": alias, default: exact }
          : { default: exact, "Default.": alias },
      };
      const result = normalizeCompatibilityConfig({ cfg: { channels: { signal } } });
      expect(signalPlugin.config.resolveAccount(result.config, "default")).toMatchObject({
        baseUrl: managed ? "http://127.0.0.1:18081" : "http://127.0.0.1:19962",
        config: { account: exact.account },
      });
      expect(result.config.channels?.signal?.accounts?.["Default."]?.transport).toBeDefined();
      expect((await signalDoctor.cleanStaleConfig?.({ cfg: result.config }))?.warnings).toEqual([
        expect.stringContaining('resolve to "default". Doctor preserved them'),
      ]);
    },
  );

  it.each([undefined, "+12025550123"])(
    "channels.status config.resolveAccount and threading use an owned number with root %s",
    (rootNumber) => {
      const cfg: OpenClawConfig = {
        channels: { signal: { account: rootNumber, accounts: { "Work Phone": authored } } },
      };
      expect(signalPlugin.config.listAccountIds(cfg)).toContain("work-phone");
      expect(signalPlugin.config.resolveAccount(cfg, "work-phone")).toMatchObject({
        configured: true,
        baseUrl: authored.transport.url,
        config: authored,
      });
      expect(signalPlugin.threading?.resolveReplyToMode?.({ cfg, accountId: "work-phone" })).toBe(
        "off",
      );
    },
  );

  it("channels.status config.resolveAccount preserves ignored settings without an owned number", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+12025550123",
          replyToMode: "all",
          accounts: { "Work Phone": { ...authored, account: undefined, enabled: false } },
        },
      },
    };
    expect(signalPlugin.config.resolveAccount(cfg, "work-phone")).toMatchObject({
      enabled: true,
      configured: true,
      transport: { kind: "managed-native" },
      config: { account: "+12025550123", replyToMode: "all" },
    });
    expect(signalPlugin.threading?.resolveReplyToMode?.({ cfg, accountId: "work-phone" })).toBe(
      "all",
    );
  });

  it.each([false, true])(
    "channels.add setup and config enable/delete update the selected stored key (collision=%s)",
    (collision) => {
      const cfg: OpenClawConfig = {
        channels: {
          signal: {
            accounts: {
              "Work Phone": authored,
              ...(collision ? { "work-phone": { ...authored, account: "+12025550125" } } : {}),
            },
          },
        },
      };
      const key = collision ? "work-phone" : "Work Phone";
      const next = expectDefined(
        signalSetupAdapter.applyAccountConfig?.({
          cfg,
          accountId: "work-phone",
          input: { httpUrl: "http://127.0.0.1:19963", signalTransport: "external-native" },
        }),
        "registered Signal setup writer",
      );
      expect(Object.keys(next.channels?.signal?.accounts ?? {})).toEqual(
        Object.keys(cfg.channels?.signal?.accounts ?? {}),
      );
      expect(next.channels?.signal?.accounts?.[key]).toMatchObject({
        account: collision ? "+12025550125" : authored.account,
        transport: { kind: "external-native", url: "http://127.0.0.1:19963" },
        replyToMode: "off",
      });
      const disabled = expectDefined(
        signalPlugin.config.setAccountEnabled?.({
          cfg: next,
          accountId: "work-phone",
          enabled: false,
        }),
        "registered Signal enable writer",
      );
      expect(disabled.channels?.signal?.accounts?.[key]?.enabled).toBe(false);
      if (collision) {
        expect(() =>
          signalPlugin.config.deleteAccount?.({ cfg: disabled, accountId: "work-phone" }),
        ).toThrow('stored keys "work-phone" and "Work Phone"');
        expect(signalPlugin.config.resolveAccount(disabled, "work-phone").config.account).toBe(
          "+12025550125",
        );
      } else {
        const removed = expectDefined(
          signalPlugin.config.deleteAccount?.({ cfg: disabled, accountId: "work-phone" }),
          "registered Signal delete writer",
        );
        expect(removed.channels?.signal?.accounts?.[key]).toBeUndefined();
        expect(signalPlugin.config.resolveAccount(removed, "work-phone").configured).toBe(false);
      }
    },
  );

  it("channels.add setup preserves the authored container transport when editing its URL", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            "Work Phone": {
              ...authored,
              transport: { kind: "container", url: authored.transport.url },
            },
          },
        },
      },
    };
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work-phone",
      input: { httpUrl: "http://127.0.0.1:19963" },
    });
    expect(next?.channels?.signal?.accounts?.["Work Phone"]?.transport).toEqual({
      kind: "container",
      url: "http://127.0.0.1:19963",
    });
  });

  it("channels.add setup reserves the managed port of a named alias", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            "Work Phone": {
              account: authored.account,
              transport: { kind: "managed-native", httpPort: 18081 },
            },
          },
        },
      },
    };
    expect(() =>
      signalSetupAdapter.applyAccountConfig?.({
        cfg,
        accountId: "personal",
        input: {
          signalNumber: "+12025550125",
          signalTransport: "external-native",
          httpUrl: "http://127.0.0.1:18081",
        },
      }),
    ).toThrow(
      'Signal managed native account "work-phone" binds port 18081, which conflicts with account "personal" local transport endpoint.',
    );
  });

  it("channels.remove config.deleteAccount normalizes a requested default alias before root cleanup", () => {
    const cfg: OpenClawConfig = {
      channels: { signal: { account: "+12025550123", accounts: { default: authored } } },
    };
    const next = expectDefined(
      signalPlugin.config.deleteAccount?.({ cfg, accountId: "Default." }),
      "registered delete adapter",
    );
    expect(next.channels?.signal?.account).toBeUndefined();
    expect(next.channels?.signal?.accounts?.default).toBeUndefined();
    expect(signalPlugin.config.resolveAccount(next, "default").configured).toBe(false);
  });
});
