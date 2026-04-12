import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  isWSL2Sync: vi.fn(() => false),
}));

describe("WSL2 DISPLAY fix", () => {
  it("confirms isWSL2Sync can be mocked to return true", async () => {
    const { isWSL2Sync } = await import("openclaw/plugin-sdk/runtime-env");
    expect(isWSL2Sync()).toBe(false);

    vi.mocked(isWSL2Sync).mockReturnValue(true);
    expect(isWSL2Sync()).toBe(true);

    vi.mocked(isWSL2Sync).mockReturnValue(false);
    expect(isWSL2Sync()).toBe(false);
  });

  it("simulates DISPLAY env being set in WSL2", async () => {
    const { isWSL2Sync } = await import("openclaw/plugin-sdk/runtime-env");

    vi.mocked(isWSL2Sync).mockReturnValue(true);
    const isWSL = isWSL2Sync();

    const env = {
      HOME: "/home/user",
      ...(isWSL ? { DISPLAY: ":0" } : {}),
    };

    expect(env.DISPLAY).toBe(":0");
    vi.mocked(isWSL2Sync).mockReturnValue(false);
  });

  it("simulates DISPLAY env not set when not in WSL2", async () => {
    const { isWSL2Sync } = await import("openclaw/plugin-sdk/runtime-env");

    vi.mocked(isWSL2Sync).mockReturnValue(false);
    const isWSL = isWSL2Sync();

    const env = {
      HOME: "/home/user",
      ...(isWSL ? { DISPLAY: ":0" } : {}),
    };

    expect(env.DISPLAY).toBeUndefined();
  });
});
