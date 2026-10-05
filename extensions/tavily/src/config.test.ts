import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTavilyApiKey } from "./config.js";

function configWithApiKey(apiKey: unknown, secrets?: OpenClawConfig["secrets"]): OpenClawConfig {
  return {
    secrets,
    plugins: { entries: { tavily: { config: { webSearch: { apiKey } } } } },
  };
}

describe("resolveTavilyApiKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { allowlist: ["TAVILY_API_KEY"], expected: "dummy" },
    { allowlist: [], expected: undefined },
  ])("honors the configured env provider allowlist $allowlist", ({ allowlist, expected }) => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");

    expect(
      resolveTavilyApiKey(
        configWithApiKey(
          {
            source: "env",
            provider: "managed-env",
            id: "TAVILY_API_KEY",
          },
          {
            providers: {
              "managed-env": { source: "env", allowlist },
            },
          },
        ),
      ),
    ).toBe(expected);
  });

  it("does not borrow TAVILY_API_KEY for a different env SecretRef", () => {
    vi.stubEnv("TAVILY_API_KEY", "dummy");
    expect(
      resolveTavilyApiKey(
        configWithApiKey({ source: "env", provider: "default", id: "OTHER_API_KEY" }),
      ),
    ).toBeUndefined();
  });
});
