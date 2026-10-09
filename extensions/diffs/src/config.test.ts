import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
// Diffs tests cover config plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import {
  diffsPluginConfigSchema,
  resolveDiffImageRenderOptions,
  resolveDiffsPluginDefaults,
} from "./config.js";
import { ensureCuratedViewerRuntimeForTests } from "./test-helpers.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";
import {
  getServedLanguagePackViewerAsset,
  LANGUAGE_PACK_VIEWER_ASSET_PREFIX,
} from "./viewer-assets.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);
const LANGUAGE_PACK_VIEWER_LOADER_PATH = `${LANGUAGE_PACK_VIEWER_ASSET_PREFIX}viewer.js`;

const FULL_DEFAULTS = {
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
  ttlSeconds: 21_600,
} as const;

beforeAll(async () => {
  await ensureCuratedViewerRuntimeForTests();
});

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  return (value: unknown) =>
    validateJsonSchemaValue({
      cacheKey: "diffs.manifest.config.test",
      schema: manifest.configSchema,
      value,
      applyDefaults: true,
    });
}

const requireRecord = createRequireRecord("object", "expected-label");

describe("resolveDiffsPluginDefaults", () => {
  it("applies configured defaults from plugin config", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: FULL_DEFAULTS,
      }),
    ).toEqual(FULL_DEFAULTS);
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

  it("prefers an explicit canonical default value over a deprecated alias", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileFormat: "png",
          imageFormat: "pdf",
        },
      }),
    ).toMatchObject({
      fileFormat: "png",
    });
  });

  it("caps plugin-wide artifact TTL defaults", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          ttlSeconds: 99_999,
        },
      }),
    ).toMatchObject({
      ttlSeconds: 21_600,
    });
  });

  it("keeps alias-only config values after manifest validation", () => {
    const validate = compileManifestConfigSchema();

    const aliasOnly = {
      defaults: {
        format: "pdf",
        imageQuality: "hq",
      },
    };
    const validatedAliasOnly = validate(aliasOnly);
    if (!validatedAliasOnly.ok) {
      throw new Error("Expected alias-only config to pass manifest validation.");
    }
    expect(resolveDiffsPluginDefaults(validatedAliasOnly.value)).toMatchObject({
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });

    const qualityOnly = {
      defaults: {
        fileQuality: "hq",
      },
    };
    const validatedQualityOnly = validate(qualityOnly);
    if (!validatedQualityOnly.ok) {
      throw new Error("Expected quality-only config to pass manifest validation.");
    }
    expect(resolveDiffsPluginDefaults(validatedQualityOnly.value)).toMatchObject({
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });
  });
});

describe("diffs plugin schema surfaces", () => {
  it("rejects invalid viewerBaseUrl values at manifest-validation time too", () => {
    const validate = compileManifestConfigSchema();

    expect(validate({ viewerBaseUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw?x=1" }).ok).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw#frag" }).ok).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw/" }).ok).toBe(true);
  });

  it("preserves defaults and security for direct safeParse callers", () => {
    const parsed = requireRecord(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "https://example.com/openclaw/",
        defaults: {
          theme: "light",
          ttlSeconds: 21_600,
        },
        security: {
          allowRemoteViewer: true,
        },
      }),
      "parse result",
    );
    expect(parsed.success).toBe(true);
    const data = requireRecord(parsed.data, "parse data");
    expect(data.viewerBaseUrl).toBe("https://example.com/openclaw");
    expect(data.defaults).toMatchObject({
      fontFamily: "Fira Code",
      fontSize: 15,
      lineSpacing: 1.6,
      layout: "unified",
      showLineNumbers: true,
      diffIndicators: "bars",
      wordWrap: true,
      background: true,
      theme: "light",
      fileFormat: "png",
      fileQuality: "standard",
      fileScale: 2,
      fileMaxWidth: 960,
      mode: "both",
      ttlSeconds: 21_600,
    });
    expect(data.security).toMatchObject({ allowRemoteViewer: true });
  });

  it("resolves deprecated aliases before safeParse applies runtime defaults", () => {
    const parsed = requireRecord(
      diffsPluginConfigSchema.safeParse?.({
        defaults: {
          format: "pdf",
          imageQuality: "hq",
        },
      }),
      "parse result",
    );
    expect(parsed.success).toBe(true);
    const data = requireRecord(parsed.data, "parse data");
    expect(data.defaults).toMatchObject({
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });
  });

  it("rejects invalid viewerBaseUrl config values", () => {
    const parsed = requireRecord(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "javascript:alert(1)",
      }),
      "parse result",
    );
    expect(parsed.success).toBe(false);
    const error = requireRecord(parsed.error, "parse error");
    const issues = error.issues as Array<{ path?: unknown; message?: unknown }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["viewerBaseUrl"]);
    expect(issues[0]?.message).toBe("viewerBaseUrl must use http or https: javascript:alert(1)");
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(diffsPluginConfigSchema.jsonSchema).toEqual(manifest.configSchema);
  });
});

describe("diffs viewer URL helpers", () => {
  it("defaults to loopback for lan/tailnet bind modes", () => {
    expect(
      buildViewerUrl({
        config: { gateway: { bind: "lan", port: 18789 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:18789/plugins/diffs/view/id/token");

    expect(
      buildViewerUrl({
        config: { gateway: { bind: "tailnet", port: 24444 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:24444/plugins/diffs/view/id/token");
  });

  it("resolves explicit, plugin, public, then bind-aware viewer bases", () => {
    expect(
      buildViewerUrl({
        config: { gateway: { publicOrigin: "https://public.example.com" } },
        baseUrl: "https://explicit.example.com/review",
        viewerBaseUrl: "https://plugin.example.com/viewer",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://explicit.example.com/review/plugins/diffs/view/id/token");
    expect(
      buildViewerUrl({
        config: { gateway: { publicOrigin: "https://public.example.com" } },
        viewerBaseUrl: "https://plugin.example.com/viewer",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://plugin.example.com/viewer/plugins/diffs/view/id/token");
    expect(
      buildViewerUrl({
        config: { gateway: { publicOrigin: "https://public.example.com" } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://public.example.com/plugins/diffs/view/id/token");
    expect(
      buildViewerUrl({
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.example.com",
            port: 443,
            tls: { enabled: true },
          },
        },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://gateway.example.com/plugins/diffs/view/id/token");
  });

  it("rejects base URLs with query/hash", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
      "baseUrl must not include query/hash",
    );
    expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
      "baseUrl must not include query/hash",
    );
  });

  it("uses the configured field name in viewerBaseUrl validation errors", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1", "viewerBaseUrl")).toThrow(
      "viewerBaseUrl must not include query/hash",
    );
  });
});

describe("viewer assets", () => {
  it("serves the optional language-pack loader only when its generated runtime is present", async () => {
    const loader = await getServedLanguagePackViewerAsset(LANGUAGE_PACK_VIEWER_LOADER_PATH);

    if (!loader) {
      expect(loader).toBeNull();
      return;
    }
    expect(loader.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(loader.body)).toContain(`./viewer-runtime.js?v=`);
  });
});

describe("parseViewerPayloadJson", () => {
  it("rejects payloads with invalid shape", () => {
    const broken = {
      prerenderedHTML: "<div>ok</div>",
      langs: ["text"],
      oldFile: { name: "README.md", contents: "before" },
      newFile: { name: "README.md", contents: "after" },
      options: {
        theme: { light: "pierre-light", dark: "pierre-dark" },
        diffStyle: "unified",
        diffIndicators: "invalid",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: ":host{}",
      },
    };
    expect(() => parseViewerPayloadJson(JSON.stringify(broken))).toThrow(
      "Diff payload has invalid shape.",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseViewerPayloadJson("{not-json")).toThrow("Diff payload is not valid JSON.");
  });
});
