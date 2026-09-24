import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  isWSL2Sync: vi.fn(() => false),
}));

let isWSL2Sync: typeof import("openclaw/plugin-sdk/runtime-env").isWSL2Sync;
let resolveTelegramAutoSelectFamilyDecision: typeof import("./network-config.js").resolveTelegramAutoSelectFamilyDecision;

// Reload after resetModules so each WSL2 case gets a fresh platform-detection cache.
async function loadModule() {
  const { isWSL2Sync: loadedIsWSL2Sync } = await import("openclaw/plugin-sdk/runtime-env");
  isWSL2Sync = loadedIsWSL2Sync;
  ({ resolveTelegramAutoSelectFamilyDecision } = await import("./network-config.js"));
}

beforeAll(async () => {
  vi.resetModules();
  await loadModule();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

describe("resolveTelegramAutoSelectFamilyDecision", () => {
  beforeEach(() => {
    vi.mocked(isWSL2Sync).mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("WSL2 detection", () => {
    beforeEach(async () => {
      vi.resetModules();
      await loadModule();
      vi.mocked(isWSL2Sync).mockReset().mockReturnValue(false);
    });

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
        env: { OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
        expected: {
          value: true,
          source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
        },
      },
      {
        name: "uses Node 22 default when not on WSL2",
        wsl2: false,
        env: {},
        expected: { value: true, source: "default-node22" },
      },
    ])("$name", ({ env, network, expected, wsl2 = true }) => {
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
      expect(resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 })).toEqual({
        value: false,
        source: "default-wsl2",
      });
      vi.mocked(isWSL2Sync).mockReturnValue(false);
      expect(resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 })).toEqual({
        value: false,
        source: "default-wsl2",
      });
      expect(isWSL2Sync).toHaveBeenCalledTimes(1);
    });
  });
});
