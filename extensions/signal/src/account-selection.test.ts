import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { signalPlugin } from "./channel.js";
import { signalDoctor } from "./doctor.js";
import { signalSetupAdapter } from "./setup-core.js";

type Signal = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;
const signalConfig = (signal: Signal): OpenClawConfig => ({ channels: { signal } });

const authored = {
  account: "+12025550124",
  transport: { kind: "external-native" as const, url: "http://127.0.0.1:19962" },
  replyToMode: "off" as const,
};
const localUrl = "http://127.0.0.1:19963";
const workId = "work-phone";
const resolve = signalPlugin.config.resolveAccount;
const setup = expectDefined(signalPlugin.setupContract, "registered setup contract");
const write = expectDefined(signalSetupAdapter.applyAccountConfig, "Signal setup writer");
const disable = expectDefined(signalPlugin.config.setAccountEnabled, "registered enable writer");
const remove = expectDefined(signalPlugin.config.deleteAccount, "registered delete writer");
const stored = (cfg: OpenClawConfig) => cfg.channels?.signal?.accounts ?? {};
const external = (signalNumber: string, httpUrl: string) => ({
  signalNumber,
  httpUrl,
  signalTransport: "external-native" as const,
});
const openPolicy = { dmPolicy: "open", allowFrom: ["*"], replyToMode: "all" } satisfies Signal;
const restrictedPolicy = {
  enabled: false,
  dmPolicy: "allowlist",
  allowFrom: ["+12025550126"],
  replyToMode: "off",
} satisfies Signal;

it.each([restrictedPolicy, undefined])("Signal setup preserves default policy %j", (policy) => {
  const { enabled, ...expected } = { enabled: true, ...(policy ?? openPolicy) };
  const cfg = signalConfig({
    ...openPolicy,
    transport: { kind: "external-native", url: "http://127.0.0.1:19961" },
    accounts: {
      "Default.": { account: "+12025550123", ...policy },
      "DEFAULT!": { account: "+12025550125", dmPolicy: "disabled" },
    },
  });
  const next = setup.applyAccountConfig({
    cfg,
    accountId: "work",
    input: external("+12025550124", "http://127.0.0.1:19962"),
  });
  expect(resolve(next, "default")).toMatchObject({
    enabled,
    config: { account: "+12025550123", ...expected },
  });
  expect(stored(next)["DEFAULT!"]).toEqual(stored(cfg)["DEFAULT!"]);
  expect(next.channels?.signal).toMatchObject(openPolicy);
  expect(stored(next).default).not.toHaveProperty("account");
  expect(resolve(next, "work").config).toMatchObject({ dmPolicy: "open", allowFrom: ["*"] });
});

it.each([false, true])(
  "Signal Doctor preserves default transport (managed=%s)",
  async (managed) => {
    const legacy = (account: string, port: number) => ({
      account,
      ...(managed ? { httpPort: 18081 } : { httpUrl: `http://127.0.0.1:${port}` }),
    });
    const exact = legacy("+12025550124", 19962);
    const signal = {
      apiMode: "native",
      accounts: { "Default.": legacy("+12025550125", 19963), default: exact },
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

it.each([false, true])("Signal writers select the stored key (collision=%s)", (collision) => {
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
  expect(Object.keys(stored(next))).toEqual(Object.keys(stored(cfg)));
  expect(stored(next)[key]).toMatchObject({
    account: collision ? "+12025550125" : authored.account,
    transport: { kind: "external-native", url: localUrl },
    replyToMode: "off",
  });
  const disabled = disable({ cfg: next, accountId: workId, enabled: false });
  expect(stored(disabled)[key]?.enabled).toBe(false);
  if (collision) {
    expect(() => remove({ cfg: disabled, accountId: workId })).toThrow(
      'stored keys "work-phone" and "Work Phone"',
    );
    expect(resolve(disabled, workId).config.account).toBe("+12025550125");
  } else {
    const removed = remove({ cfg: disabled, accountId: workId });
    expect(stored(removed)[key]).toBeUndefined();
    expect(resolve(removed, workId).configured).toBe(false);
  }
});
