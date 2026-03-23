import { describe, expect, it } from "vitest";
import { DEFAULT_DDG_SAFE_SEARCH, resolveDdgRegion, resolveDdgSafeSearch } from "./config.js";

describe("duckduckgo config", () => {
  it("reads region from plugin config", () => {
    expect(
      resolveDdgRegion({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  region: "de-de",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("de-de");
  });

  it("normalizes empty region to undefined", () => {
    expect(
      resolveDdgRegion({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  region: "   ",
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("defaults safeSearch to moderate", () => {
    expect(resolveDdgSafeSearch(undefined)).toBe(DEFAULT_DDG_SAFE_SEARCH);
  });

  it("accepts strict and off safeSearch values", () => {
    expect(
      resolveDdgSafeSearch({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  safeSearch: "strict",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("strict");

    expect(
      resolveDdgSafeSearch({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  safeSearch: "off",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("off");
  });
});
