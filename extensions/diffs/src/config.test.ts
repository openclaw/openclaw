import { describe, expect, it } from "vitest";
import { DEFAULT_DIFFS_TOOL_DEFAULTS, resolveDiffsPluginDefaults } from "./config.js";

describe("resolveDiffsPluginDefaults", () => {
  it("returns built-in defaults when config is missing", () => {
    expect(resolveDiffsPluginDefaults(undefined)).toEqual(DEFAULT_DIFFS_TOOL_DEFAULTS);
  });

  it("applies configured defaults from plugin config", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fontFamily: "JetBrains Mono",
          fontSize: 17,
          layout: "split",
          wordWrap: false,
          background: false,
          theme: "light",
          mode: "view",
        },
      }),
    ).toEqual({
      fontFamily: "JetBrains Mono",
      fontSize: 17,
      layout: "split",
      wordWrap: false,
      background: false,
      theme: "light",
      mode: "view",
    });
  });
});
