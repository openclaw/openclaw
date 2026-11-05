import { describe, expect, it } from "vitest";
import { requireApiKey, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { AuthStorage } from "./sessions/auth-storage.js";

describe("native login HTTP boundary", () => {
  it("rejects a native presence marker without exposing its value", () => {
    const auth: ResolvedProviderAuth = {
      apiKey: "synthetic-native-presence",
      source: "native login",
      mode: "oauth",
      nativeAuth: { runtime: "claude-cli", mode: "oauth" },
    };
    expect(() => requireApiKey(auth, "claude-cli")).toThrow("cannot authorize an HTTP request");
    try {
      requireApiKey(auth, "claude-cli");
    } catch (error) {
      expect(String(error)).not.toContain(auth.apiKey);
    }
  });

  it("preserves ordinary HTTP credentials", () => {
    expect(
      requireApiKey({ apiKey: "fixture-http-key", source: "fixture", mode: "api-key" }, "custom"),
    ).toBe("fixture-http-key");
  });

  it("retains native availability while falling back to a configured HTTP key", async () => {
    const auth = AuthStorage.inMemory({
      custom: {
        type: "api_key",
        key: "synthetic-native-presence",
        nativeAuth: { runtime: "native-fixture", mode: "oauth" },
      },
    });
    auth.setFallbackResolver(() => "fixture-http-key");
    expect(auth.hasAuth("custom")).toBe(true);
    await expect(auth.getApiKey("custom", { includeFallback: false })).resolves.toBeUndefined();
    await expect(auth.getApiKey("custom")).resolves.toBe("fixture-http-key");
  });
});
