import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { signalPlugin } from "./channel.js";
import { signalDoctor } from "./doctor.js";
import { signalSetupAdapter } from "./setup-core.js";

function signalConfig(signal: NonNullable<OpenClawConfig["channels"]>["signal"]): OpenClawConfig {
  return { channels: { signal } };
}

const authored = {
  account: "+12025550124",
  transport: { kind: "external-native" as const, url: "http://127.0.0.1:19962" },
  replyToMode: "off" as const,
};
const localUrl = "http://127.0.0.1:19963";
const workId = "work-phone";
const resolve = signalPlugin.config.resolveAccount;
const setup = expectDefined(signalPlugin.setupContract, "registered setup contract");
const write = expectDefined(
  signalSetupAdapter.applyAccountConfig,
  "registered Signal setup writer",
);
const disable = expectDefined(signalPlugin.config.setAccountEnabled, "registered enable writer");
const remove = expectDefined(signalPlugin.config.deleteAccount, "registered delete writer");

describe("Signal registered account entry points", () => {
  it.each([true, false])(
    "channels.add setupContract preserves default winner when restoring its number (restricted=%s)",
    (restricted) => {
      const cfg = signalConfig({
        replyToMode: "all",
        dmPolicy: "open",
        allowFrom: ["*"],
        transport: { kind: "external-native", url: "http://127.0.0.1:19961" },
        accounts: {
          "Default.": {
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
      });
      const next = setup.applyAccountConfig({
        cfg,
        accountId: "work",
        input: {
          signalNumber: "+12025550124",
          signalTransport: "external-native",
          httpUrl: "http://127.0.0.1:19962",
        },
      });
      expect(resolve(next, "default")).toMatchObject({
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
      expect(resolve(next, "work").config).toMatchObject({
        dmPolicy: "open",
        allowFrom: ["*"],
      });
    },
  );

  it.each([false, true])(
    "Doctor normalizeCompatibilityConfig keeps the exact default transport (managed=%s)",
    async (managed) => {
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
        accounts: { "Default.": alias, default: exact },
      };
      const result = normalizeCompatibilityConfig({ cfg: { channels: { signal } } });
      expect(resolve(result.config, "default")).toMatchObject({
        baseUrl: managed ? "http://127.0.0.1:18081" : "http://127.0.0.1:19962",
        config: { account: exact.account },
      });
      expect(result.config.channels?.signal?.accounts?.["Default."]?.transport).toBeDefined();
      expect((await signalDoctor.cleanStaleConfig?.({ cfg: result.config }))?.warnings).toEqual([
        expect.stringContaining('resolve to "default". Doctor preserved them'),
      ]);
    },
  );

  it("channels.status config.resolveAccount and threading use an owned number", () => {
    const cfg = signalConfig({ account: "+12025550123", accounts: { "Work Phone": authored } });
    expect(signalPlugin.config.listAccountIds(cfg)).toContain(workId);
    expect(resolve(cfg, workId)).toMatchObject({
      configured: true,
      baseUrl: authored.transport.url,
      config: authored,
    });
    expect(signalPlugin.threading?.resolveReplyToMode?.({ cfg, accountId: workId })).toBe("off");
  });

  it.each([false, true])(
    "channels.add setup and config enable/delete update the selected stored key (collision=%s)",
    (collision) => {
      const cfg = signalConfig({
        accounts: {
          "Work Phone": authored,
          ...(collision ? { "work-phone": { ...authored, account: "+12025550125" } } : {}),
        },
      });
      const key = collision ? "work-phone" : "Work Phone";
      const next = write({
        cfg,
        accountId: workId,
        input: { httpUrl: localUrl, signalTransport: "external-native" },
      });
      expect(Object.keys(next.channels?.signal?.accounts ?? {})).toEqual(
        Object.keys(cfg.channels?.signal?.accounts ?? {}),
      );
      expect(next.channels?.signal?.accounts?.[key]).toMatchObject({
        account: collision ? "+12025550125" : authored.account,
        transport: { kind: "external-native", url: localUrl },
        replyToMode: "off",
      });
      const disabled = disable({ cfg: next, accountId: workId, enabled: false });
      expect(disabled.channels?.signal?.accounts?.[key]?.enabled).toBe(false);
      if (collision) {
        expect(() => remove({ cfg: disabled, accountId: workId })).toThrow(
          'stored keys "work-phone" and "Work Phone"',
        );
        expect(resolve(disabled, workId).config.account).toBe("+12025550125");
      } else {
        const removed = remove({ cfg: disabled, accountId: workId });
        expect(removed.channels?.signal?.accounts?.[key]).toBeUndefined();
        expect(resolve(removed, workId).configured).toBe(false);
      }
    },
  );

  it("channels.add setup preserves the authored container transport when editing its URL", () => {
    const cfg = signalConfig({
      accounts: {
        "Work Phone": {
          ...authored,
          transport: { kind: "container", url: authored.transport.url },
        },
      },
    });
    const next = write({
      cfg,
      accountId: workId,
      input: { httpUrl: localUrl },
    });
    expect(next?.channels?.signal?.accounts?.["Work Phone"]?.transport).toEqual({
      kind: "container",
      url: localUrl,
    });
  });

  it("channels.add setup reserves the managed port of a named alias", () => {
    const cfg = signalConfig({
      accounts: {
        "Work Phone": {
          account: authored.account,
          transport: { kind: "managed-native", httpPort: 18081 },
        },
      },
    });
    expect(() =>
      write({
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
});
