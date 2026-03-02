import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIFFS_PLUGIN_SECURITY,
  DEFAULT_DIFFS_TOOL_DEFAULTS,
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
} from "./config.js";

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
          lineSpacing: 1.8,
          layout: "split",
          showLineNumbers: false,
          diffIndicators: "classic",
          wordWrap: false,
          background: false,
          theme: "light",
          mode: "view",
        },
      }),
    ).toEqual({
      fontFamily: "JetBrains Mono",
      fontSize: 17,
      lineSpacing: 1.8,
      layout: "split",
      showLineNumbers: false,
      diffIndicators: "classic",
      wordWrap: false,
      background: false,
      theme: "light",
      mode: "view",
    });
  });

  it("clamps and falls back for invalid line spacing and indicators", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: -5,
          diffIndicators: "unknown",
        },
      }),
    ).toMatchObject({
      lineSpacing: 1,
      diffIndicators: "bars",
    });

    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: 9,
        },
      }),
    ).toMatchObject({
      lineSpacing: 3,
    });

    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: Number.NaN,
        },
      }),
    ).toMatchObject({
      lineSpacing: DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing,
    });
  });
});

describe("resolveDiffsPluginSecurity", () => {
  it("defaults to local-only viewer access", () => {
    expect(resolveDiffsPluginSecurity(undefined)).toEqual(DEFAULT_DIFFS_PLUGIN_SECURITY);
  });

  it("allows opt-in remote viewer access", () => {
    expect(resolveDiffsPluginSecurity({ security: { allowRemoteViewer: true } })).toEqual({
      allowRemoteViewer: true,
    });
  });
});
