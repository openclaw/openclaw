import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FIRECRAWL_BASE_URL,
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
} from "./config.js";

describe("firecrawl legacy config own entries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["search", "fetch"] as const)(
    "ignores inherited legacy %s firecrawl config entries",
    (configKey) => {
      vi.stubEnv("FIRECRAWL_API_KEY", "");
      vi.stubEnv("FIRECRAWL_BASE_URL", "");
      const inheritedConfig = Object.create({
        firecrawl: {
          apiKey: "inherited-key",
          baseUrl: "https://inherited.firecrawl.test",
        },
      });
      const cfg = {
        tools: { web: { [configKey]: inheritedConfig } },
      } as OpenClawConfig;

      expect(resolveFirecrawlApiKey(cfg)).toBeUndefined();
      expect(resolveFirecrawlBaseUrl(cfg)).toBe(DEFAULT_FIRECRAWL_BASE_URL);
    },
  );
});
