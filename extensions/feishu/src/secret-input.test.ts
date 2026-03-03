import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedFeishuSdk = vi.hoisted(() => ({
  hasConfiguredSecretInput: vi.fn((value: unknown) => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const ref = value as { source?: unknown; provider?: unknown; id?: unknown };
    const validSource = ref.source === "env" || ref.source === "file" || ref.source === "exec";
    return (
      validSource &&
      typeof ref.provider === "string" &&
      ref.provider.trim().length > 0 &&
      typeof ref.id === "string" &&
      ref.id.trim().length > 0
    );
  }),
  normalizeResolvedSecretInputString: undefined as
    | ((params: { value: unknown; refValue?: unknown; path: string }) => string | undefined)
    | undefined,
  normalizeSecretInputString: undefined as ((value: unknown) => string | undefined) | undefined,
}));

vi.mock("openclaw/plugin-sdk/feishu", () => mockedFeishuSdk);

describe("feishu secret input compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
    mockedFeishuSdk.hasConfiguredSecretInput.mockClear();
    mockedFeishuSdk.normalizeResolvedSecretInputString = undefined;
    mockedFeishuSdk.normalizeSecretInputString = undefined;
  });

  it("falls back to local string normalization when host helper is missing", async () => {
    const { normalizeSecretInputString } = await import("./secret-input.js");

    expect(normalizeSecretInputString("  secret  ")).toBe("secret");
    expect(normalizeSecretInputString("   ")).toBeUndefined();
  });

  it("preserves unresolved SecretRef errors when resolved helper is missing", async () => {
    const { normalizeResolvedSecretInputString } = await import("./secret-input.js");

    expect(() =>
      normalizeResolvedSecretInputString({
        value: { source: "env", provider: "default", id: "FEISHU_APP_SECRET" },
        path: "channels.feishu.appSecret",
      }),
    ).toThrow(/unresolved SecretRef/i);
  });

  it("delegates to host helpers when the runtime exports them", async () => {
    const hostNormalizeSecretInputString = vi.fn(() => "from-host");
    const hostNormalizeResolvedSecretInputString = vi.fn(() => "resolved-from-host");
    mockedFeishuSdk.normalizeSecretInputString = hostNormalizeSecretInputString;
    mockedFeishuSdk.normalizeResolvedSecretInputString = hostNormalizeResolvedSecretInputString;

    const { normalizeResolvedSecretInputString, normalizeSecretInputString } = await import(
      "./secret-input.js"
    );

    expect(normalizeSecretInputString("  secret  ")).toBe("from-host");
    expect(hostNormalizeSecretInputString).toHaveBeenCalledWith("  secret  ");

    expect(
      normalizeResolvedSecretInputString({
        value: "  secret  ",
        path: "channels.feishu.appSecret",
      }),
    ).toBe("resolved-from-host");
    expect(hostNormalizeResolvedSecretInputString).toHaveBeenCalledWith({
      value: "  secret  ",
      path: "channels.feishu.appSecret",
    });
  });
});
