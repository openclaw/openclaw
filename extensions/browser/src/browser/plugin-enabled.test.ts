import { describe, expect, it } from "vitest";
import type { MullusiConfig } from "../config/config.js";
import { isDefaultBrowserPluginEnabled } from "./plugin-enabled.js";

describe("isDefaultBrowserPluginEnabled", () => {
  it("defaults to enabled", () => {
    expect(isDefaultBrowserPluginEnabled({} as MullusiConfig)).toBe(true);
  });

  it("respects explicit plugin disablement", () => {
    expect(
      isDefaultBrowserPluginEnabled({
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as MullusiConfig),
    ).toBe(false);
  });
});
