import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIFFS_PLUGIN_SECURITY,
  DEFAULT_DIFFS_TOOL_DEFAULTS,
  resolveDiffImageRenderOptions,
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
          fileFormat: "pdf",
          fileQuality: "hq",
          fileScale: 2.6,
          fileMaxWidth: 1280,
          mode: "file",
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
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.6,
      fileMaxWidth: 1280,
      mode: "file",
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

  it("derives file defaults from quality preset and clamps explicit overrides", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileQuality: "print",
        },
      }),
    ).toMatchObject({
      fileQuality: "print",
      fileScale: 3,
      fileMaxWidth: 1400,
    });

    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileQuality: "hq",
          fileScale: 99,
          fileMaxWidth: 99999,
        },
      }),
    ).toMatchObject({
      fileQuality: "hq",
      fileScale: 4,
      fileMaxWidth: 2400,
    });
  });

  it("falls back to png for invalid file format defaults", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileFormat: "invalid" as "png",
        },
      }),
    ).toMatchObject({
      fileFormat: "png",
    });
  });

  it("resolves file render format from defaults and explicit overrides", () => {
    const defaults = resolveDiffsPluginDefaults({
      defaults: {
        fileFormat: "pdf",
      },
    });

    expect(resolveDiffImageRenderOptions({ defaults }).format).toBe("pdf");
    expect(resolveDiffImageRenderOptions({ defaults, fileFormat: "png" }).format).toBe("png");
    expect(resolveDiffImageRenderOptions({ defaults, format: "png" }).format).toBe("png");
  });

  it("accepts format as a config alias for fileFormat", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          format: "pdf",
        },
      }),
    ).toMatchObject({
      fileFormat: "pdf",
    });
  });

  it("accepts image* config aliases for backward compatibility", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          imageFormat: "pdf",
          imageQuality: "hq",
          imageScale: 2.2,
          imageMaxWidth: 1024,
        },
      }),
    ).toMatchObject({
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.2,
      fileMaxWidth: 1024,
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
