import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { createDiscordRestClient } from "./client.js";

describe("createDiscordRestClient proxy support", () => {
  it("injects a custom fetch into RequestClient when a Discord proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toEqual(expect.any(Function));
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("does not inject fetch when no proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toBeUndefined();
  });
});
