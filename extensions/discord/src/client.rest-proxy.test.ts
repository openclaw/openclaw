import { describe, expect, it } from "vitest";
import { createDiscordRestClient } from "./client.js";

describe("createDiscordRestClient proxy wiring", () => {
  it("accepts discord proxy configuration without throwing when constructing the default REST client", () => {
    expect(() =>
      createDiscordRestClient({
        cfg: {
          channels: {
            discord: {
              proxy: "http://proxy.test:8080",
              accounts: {
                default: {
                  token: "t",
                },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("does not rebuild an injected REST client even when discord proxy is configured", () => {
    const injectedRest = {
      get() {},
      post() {},
      put() {},
      patch() {},
      delete() {},
    } as unknown as ReturnType<typeof createDiscordRestClient>["rest"];

    const result = createDiscordRestClient({
      rest: injectedRest,
      cfg: {
        channels: {
          discord: {
            proxy: "http://proxy.test:8080",
            accounts: {
              default: {
                token: "t",
              },
            },
          },
        },
      },
    });

    expect(result.rest).toBe(injectedRest);
  });
});
