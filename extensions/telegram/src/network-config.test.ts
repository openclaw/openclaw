import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  getDefaultResultOrder: () => "verbatim",
}));

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
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", undefined);
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
        expected: false,
      },
      {
        name: "respects config override on WSL2",
        network: { autoSelectFamily: true },
        expected: true,
      },
      {
        name: "respects env override on WSL2",
        enabled: true,
        expected: true,
      },
      {
        name: "uses the supported runtime default when not on WSL2",
        wsl2: false,
        expected: true,
      },
    ])("$name", ({ enabled, network, expected, wsl2 = true }) => {
      vi.mocked(isWSL2Sync).mockReturnValue(wsl2);
      vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", enabled ? "1" : undefined);
      const decision = resolveTelegramAutoSelectFamilyDecision({
        network,
      });
      expect(decision).toEqual(expected);
    });

    it("memoizes WSL2 detection across repeated defaults", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(true);
      expect(resolveTelegramAutoSelectFamilyDecision()).toBe(false);
      vi.mocked(isWSL2Sync).mockReturnValue(false);
      expect(resolveTelegramAutoSelectFamilyDecision()).toBe(false);
      expect(isWSL2Sync).toHaveBeenCalledTimes(1);
    });
  });
});
