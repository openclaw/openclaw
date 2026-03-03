import { beforeEach, describe, expect, it, vi } from "vitest";

describe("feishu secret-input compatibility helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unmock("openclaw/plugin-sdk");
  });

  it("uses plugin-sdk secret helpers when available", async () => {
    const normalizeSecretInputString = vi.fn((value: unknown) =>
      typeof value === "string" ? value.trim() || undefined : undefined,
    );
    const normalizeResolvedSecretInputString = vi.fn((params: { value: unknown; path: string }) =>
      typeof params.value === "string" ? params.value.trim() || undefined : undefined,
    );
    const hasConfiguredSecretInput = vi.fn((value: unknown) => value === "configured");

    vi.doMock("openclaw/plugin-sdk", () => ({
      normalizeSecretInputString,
      normalizeResolvedSecretInputString,
      hasConfiguredSecretInput,
    }));

    const mod = await import("./secret-input.js");

    expect(mod.normalizeSecretInputString("  value  ")).toBe("value");
    expect(mod.hasConfiguredSecretInput("configured")).toBe(true);
    expect(
      mod.normalizeResolvedSecretInputString({
        value: "  token  ",
        path: "channels.feishu.accounts.default.appSecret",
      }),
    ).toBe("token");

    expect(normalizeSecretInputString).toHaveBeenCalledTimes(1);
    expect(hasConfiguredSecretInput).toHaveBeenCalledTimes(1);
    expect(normalizeResolvedSecretInputString).toHaveBeenCalledTimes(1);
  });

  it("falls back to local normalization when plugin-sdk secret helpers are missing", async () => {
    vi.doMock("openclaw/plugin-sdk", () => ({
      normalizeSecretInputString: undefined,
      normalizeResolvedSecretInputString: undefined,
      hasConfiguredSecretInput: undefined,
    }));
    const mod = await import("./secret-input.js");

    expect(mod.normalizeSecretInputString("  app-secret  ")).toBe("app-secret");
    expect(mod.normalizeSecretInputString("   ")).toBeUndefined();

    expect(mod.hasConfiguredSecretInput("  token  ")).toBe(true);
    expect(
      mod.hasConfiguredSecretInput({
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      }),
    ).toBe(true);

    expect(() =>
      mod.normalizeResolvedSecretInputString({
        value: {
          source: "env",
          provider: "default",
          id: "FEISHU_APP_SECRET",
        },
        path: "channels.feishu.accounts.default.appSecret",
      }),
    ).toThrow(/unresolved SecretRef/);
  });
});
