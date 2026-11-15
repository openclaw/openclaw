import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveBrowserPluginEnableState } from "./plugin-enabled.js";

describe("resolveBrowserPluginEnableState", () => {
  it("respects explicit plugin disablement", () => {
    expect(
      resolveBrowserPluginEnableState({
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({ enabled: false, reason: "disabled in config" });
  });
});
