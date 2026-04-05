import type { TelegramNetworkConfig } from "mullusi/plugin-sdk/config-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mullusi/plugin-sdk/runtime-env", () => ({
  isTruthyEnvValue: (value: string | undefined) =>
    typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim()),
  isWSL2Sync: vi.fn(() => false),
}));

let isWSL2Sync: typeof import("mullusi/plugin-sdk/runtime-env").isWSL2Sync;
let resetTelegramNetworkConfigStateForTests: typeof import("./network-config.js").resetTelegramNetworkConfigStateForTests;
let resolveTelegramAutoSelectFamilyDecision: typeof import("./network-config.js").resolveTelegramAutoSelectFamilyDecision;
let resolveTelegramDnsResultOrderDecision: typeof import("./network-config.js").resolveTelegramDnsResultOrderDecision;

async function loadModule() {
  ({ isWSL2Sync } = await import("mullusi/plugin-sdk/runtime-env"));
  ({
    resetTelegramNetworkConfigStateForTests,
    resolveTelegramAutoSelectFamilyDecision,
    resolveTelegramDnsResultOrderDecision,
  } = await import("./network-config.js"));
}

describe("resolveTelegramAutoSelectFamilyDecision", () => {
  beforeAll(async () => {
    await loadModule();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (!resetTelegramNetworkConfigStateForTests) {
      await loadModule();
    }
    resetTelegramNetworkConfigStateForTests();
  });

  it.each([
    {
      name: "prefers env enable over env disable",
      env: {
        MULLUSI_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1",
        MULLUSI_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1",
      },
      expected: {
        value: true,
        source: "env:MULLUSI_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
      },
    },
    {
      name: "uses env disable when set",
      env: { MULLUSI_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1" },
      expected: {
        value: false,
        source: "env:MULLUSI_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY",
      },
    },
    {
      name: "prefers env enable over config",
      env: { MULLUSI_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
      network: { autoSelectFamily: false },
      expected: {
        value: true,
        source: "env:MULLUSI_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
      },
    },
    {
      name: "prefers env disable over config",
      env: { MULLUSI_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1" },
      network: { autoSelectFamily: true },
      expected: {
        value: false,
        source: "env:MULLUSI_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY",
      },
    },
    {
      name: "uses config override when provided",
      env: {},
      network: { autoSelectFamily: true },
      expected: { value: true, source: "config" },
    },
  ])("$name", ({ env, network, expected }) => {
    if (!resolveTelegramAutoSelectFamilyDecision) {
      throw new Error("network-config module not loaded");
    }
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env,
      network,
      nodeMajor: 22,
    });
    expect(decision).toEqual(expected);
  });

  it("defaults to enable on Node 22", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
    expect(decision).toEqual({ value: true, source: "default-node22" });
  });

  it("returns null when no decision applies", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });

  describe("WSL2 detection", () => {
    it.each([
      {
        name: "disables autoSelectFamily on WSL2",
        env: {},
        expected: { value: false, source: "default-wsl2" },
      },
      {
        name: "respects config override on WSL2",
        env: {},
        network: { autoSelectFamily: true },
        expected: { value: true, source: "config" },
      },
      {
        name: "respects env override on WSL2",
        env: { MULLUSI_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
        expected: {
          value: true,
          source: "env:MULLUSI_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
        },
      },
      {
        name: "uses Node 22 default when not on WSL2",
        wsl2: false,
        env: {},
        expected: { value: true, source: "default-node22" },
      },
    ])("$name", ({ env, network, expected, wsl2 = true }) => {
      if (!isWSL2Sync) {
        throw new Error("runtime-env mock not loaded");
      }
      vi.mocked(isWSL2Sync).mockReturnValue(wsl2);
      const decision = resolveTelegramAutoSelectFamilyDecision({
        env,
        network,
        nodeMajor: 22,
      });
      expect(decision).toEqual(expected);
    });

    it("memoizes WSL2 detection across repeated defaults", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(true);
      vi.mocked(isWSL2Sync).mockClear();
      vi.mocked(isWSL2Sync).mockReturnValue(false);
      resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      expect(isWSL2Sync).toHaveBeenCalledTimes(1);
    });
  });
});

describe("resolveTelegramDnsResultOrderDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "uses env override when provided",
      env: { MULLUSI_TELEGRAM_DNS_RESULT_ORDER: "verbatim" },
      nodeMajor: 22,
      expected: {
        value: "verbatim",
        source: "env:MULLUSI_TELEGRAM_DNS_RESULT_ORDER",
      },
    },
    {
      name: "normalizes trimmed env values",
      env: { MULLUSI_TELEGRAM_DNS_RESULT_ORDER: "  IPV4FIRST  " },
      nodeMajor: 20,
      expected: {
        value: "ipv4first",
        source: "env:MULLUSI_TELEGRAM_DNS_RESULT_ORDER",
      },
    },
    {
      name: "uses config override when provided",
      network: { dnsResultOrder: "ipv4first" },
      nodeMajor: 20,
      expected: { value: "ipv4first", source: "config" },
    },
    {
      name: "normalizes trimmed config values",
      network: { dnsResultOrder: "  Verbatim  " } as TelegramNetworkConfig & {
        dnsResultOrder: string;
      },
      nodeMajor: 20,
      expected: { value: "verbatim", source: "config" },
    },
    {
      name: "ignores invalid env values and falls back to config",
      env: { MULLUSI_TELEGRAM_DNS_RESULT_ORDER: "bogus" },
      network: { dnsResultOrder: "ipv4first" },
      nodeMajor: 20,
      expected: { value: "ipv4first", source: "config" },
    },
    {
      name: "ignores invalid env and config values before applying Node 22 default",
      env: { MULLUSI_TELEGRAM_DNS_RESULT_ORDER: "bogus" },
      network: { dnsResultOrder: "invalid" } as TelegramNetworkConfig & { dnsResultOrder: string },
      nodeMajor: 22,
      expected: { value: "ipv4first", source: "default-node22" },
    },
  ] satisfies Array<{
    name: string;
    env?: NodeJS.ProcessEnv;
    network?: TelegramNetworkConfig | (TelegramNetworkConfig & { dnsResultOrder: string });
    nodeMajor: number;
    expected: ReturnType<typeof resolveTelegramDnsResultOrderDecision>;
  }>)("$name", ({ env, network, nodeMajor, expected }) => {
    const decision = resolveTelegramDnsResultOrderDecision({
      env,
      network,
      nodeMajor,
    });
    expect(decision).toEqual(expected);
  });

  it("defaults to ipv4first on Node 22", () => {
    const decision = resolveTelegramDnsResultOrderDecision({ nodeMajor: 22 });
    expect(decision).toEqual({ value: "ipv4first", source: "default-node22" });
  });

  it("returns null when no dns decision applies", () => {
    const decision = resolveTelegramDnsResultOrderDecision({ nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });
});
