import { describe, expect, it } from "vitest";
import { __testing } from "./bocha-web-search-provider.js";
import { __testing as runtimeTesting } from "./bocha-web-search-provider.runtime.js";

describe("bocha web search provider helpers", () => {
  it("resolves bocha scoped defaults", () => {
    expect(runtimeTesting.resolveBochaApiKey(undefined, { apiKey: "bocha-secret" })).toBe(
      "bocha-secret",
    );
    expect(runtimeTesting.resolveBochaBaseUrl()).toBe("https://api.bocha.cn/v1");
  });

  it("reads bocha-specific overrides from scoped config", () => {
    expect(runtimeTesting.resolveBochaBaseUrl({ baseUrl: "https://custom.bocha.cn/v1" })).toBe(
      "https://custom.bocha.cn/v1",
    );
  });

  it("resolves empty bocha config when no scoped config is present", () => {
    expect(__testing.resolveBochaConfig()).toEqual({});
    expect(__testing.resolveBochaConfig({ bocha: { summary: true } })).toEqual({ summary: true });
  });
});
