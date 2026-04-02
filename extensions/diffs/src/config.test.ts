import fs from "node:fs";
import {
  disposeHighlighter,
  RegisteredCustomThemes,
  ResolvedThemes,
  ResolvingThemes,
} from "@pierre/diffs";
import AjvPkg from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIFFS_PLUGIN_SECURITY,
  DEFAULT_DIFFS_TOOL_DEFAULTS,
  diffsPluginConfigSchema,
  resolveDiffImageRenderOptions,
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { renderDiffDocument } from "./render.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";
import {
  getServedViewerAsset,
  resolveViewerRuntimeFileUrl,
  VIEWER_LOADER_PATH,
  VIEWER_RUNTIME_PATH,
} from "./viewer-assets.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

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
} as const;

describe("resolveDiffsPluginDefaults", () => {
  it("returns built-in defaults when config is missing", () => {
    expect(resolveDiffsPluginDefaults(undefined)).toEqual(DEFAULT_DIFFS_TOOL_DEFAULTS);
  });

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

  it("keeps loader-applied schema defaults from shadowing aliases and quality-derived defaults", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: Record<string, unknown> };
    const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    const validate = ajv.compile(manifest.configSchema);

    const aliasOnly = {
      defaults: {
        format: "pdf",
        imageQuality: "hq",
      },
    };
    expect(validate(aliasOnly)).toBe(true);
    expect(resolveDiffsPluginDefaults(aliasOnly)).toMatchObject({
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
    expect(validate(qualityOnly)).toBe(true);
    expect(resolveDiffsPluginDefaults(qualityOnly)).toMatchObject({
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
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

describe("resolveDiffsPluginViewerBaseUrl", () => {
  it("defaults to undefined when config is missing", () => {
    expect(resolveDiffsPluginViewerBaseUrl(undefined)).toBeUndefined();
  });

  it("normalizes configured viewer base URLs", () => {
    expect(
      resolveDiffsPluginViewerBaseUrl({
        viewerBaseUrl: "https://example.com/openclaw/",
      }),
    ).toBe("https://example.com/openclaw");
  });
});

describe("diffs plugin schema surfaces", () => {
  it("preserves defaults and security for direct safeParse callers", () => {
    expect(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "https://example.com/openclaw/",
        defaults: {
          theme: "light",
        },
        security: {
          allowRemoteViewer: true,
        },
      }),
    ).toMatchObject({
      success: true,
      data: {
        viewerBaseUrl: "https://example.com/openclaw",
        defaults: {
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
        },
        security: {
          allowRemoteViewer: true,
        },
      },
    });
  });

  it("canonicalizes alias-driven defaults for direct safeParse callers", () => {
    expect(
      diffsPluginConfigSchema.safeParse?.({
        defaults: {
          format: "pdf",
          imageQuality: "hq",
        },
      }),
    ).toMatchObject({
      success: true,
      data: {
        defaults: {
          fileFormat: "pdf",
          fileQuality: "hq",
          fileScale: 2.5,
          fileMaxWidth: 1200,
        },
      },
    });
  });

  it("rejects invalid viewerBaseUrl config values", () => {
    expect(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "javascript:alert(1)",
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            path: ["viewerBaseUrl"],
            message: "viewerBaseUrl must use http or https: javascript:alert(1)",
          },
        ],
      },
    });
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

  it("uses custom bind host when provided", () => {
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

  it("joins viewer path under baseUrl pathname", () => {
    expect(
      buildViewerUrl({
        config: {},
        baseUrl: "https://example.com/openclaw",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
  });

  it("prefers normalized viewerBaseUrl strings too", () => {
    expect(
      buildViewerUrl({
        config: {},
        baseUrl: "https://example.com/openclaw/",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
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

describe("renderDiffDocument", () => {
  it("renders before/after input into a complete viewer document", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
        path: "src/example.ts",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    expect(rendered.title).toBe("src/example.ts");
    expect(rendered.fileCount).toBe(1);
    expect(rendered.html).toContain("data-openclaw-diff-root");
    expect(rendered.html).toContain("src/example.ts");
    expect(rendered.html).toContain("../../assets/viewer.js");
    expect(rendered.imageHtml).toContain("../../assets/viewer.js");
    expect(rendered.imageHtml).toContain("max-width: 960px;");
    expect(rendered.imageHtml).toContain("--diffs-font-size: 16px;");
    expect(rendered.html).toContain("min-height: 100vh;");
    expect(rendered.html).toContain('"diffIndicators":"bars"');
    expect(rendered.html).toContain('"disableLineNumbers":false');
    expect(rendered.html).toContain("--diffs-line-height: 24px;");
    expect(rendered.html).toContain("--diffs-font-size: 15px;");
    expect(rendered.html).not.toContain("fonts.googleapis.com");
  });

  it("resolves viewer assets under an optional base path", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    const html = rendered.html ?? "";
    const loaderSrc = html.match(/<script type="module" src="([^"]+)"><\/script>/)?.[1];
    expect(loaderSrc).toBe("../../assets/viewer.js");
    expect(
      new URL(loaderSrc ?? "", "https://example.com/openclaw/plugins/diffs/view/id/token").pathname,
    ).toBe("/openclaw/plugins/diffs/assets/viewer.js");
  });

  it("downgrades invalid language hints to plain text", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
        lang: "not-a-real-language",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    const html = rendered.html ?? "";

    expect(rendered.title).toBe("Text diff");
    expect(html).toContain("diff.txt");
    expect(html).not.toContain("not-a-real-language");

    const payloads = [...html.matchAll(/data-openclaw-diff-payload>(.*?)<\/script>/g)].map(
      (match) => parseViewerPayloadJson(match[1] ?? ""),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.langs).toEqual(["text"]);
    expect(payloads[0]?.oldFile?.lang).toBeUndefined();
    expect(payloads[0]?.newFile?.lang).toBeUndefined();
  });

  it("renders multi-file patch input", async () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
    ].join("\n");

    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch,
        title: "Workspace patch",
      },
      {
        presentation: {
          ...DEFAULT_DIFFS_TOOL_DEFAULTS,
          layout: "split",
          theme: "dark",
        },
        image: resolveDiffImageRenderOptions({
          defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
          fileQuality: "hq",
          fileMaxWidth: 1180,
        }),
        expandUnchanged: true,
      },
    );

    expect(rendered.title).toBe("Workspace patch");
    expect(rendered.fileCount).toBe(2);
    expect(rendered.html).toContain("Workspace patch");
    expect(rendered.imageHtml).toContain("max-width: 1180px;");
  });

  it("re-registers pierre theme loaders before rendering", async () => {
    await disposeHighlighter();

    const originalLightLoader = RegisteredCustomThemes.get("pierre-light");
    const originalDarkLoader = RegisteredCustomThemes.get("pierre-dark");
    const brokenLoader = async () => {
      throw new Error("broken pierre theme loader");
    };

    RegisteredCustomThemes.set("pierre-light", brokenLoader);
    RegisteredCustomThemes.set("pierre-dark", brokenLoader);
    ResolvedThemes.delete("pierre-light");
    ResolvedThemes.delete("pierre-dark");
    ResolvingThemes.delete("pierre-light");
    ResolvingThemes.delete("pierre-dark");

    try {
      const rendered = await renderDiffDocument(
        {
          kind: "before_after",
          before: "const value = 1;\n",
          after: "const value = 2;\n",
          path: "src/example.ts",
        },
        {
          presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
          image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
          expandUnchanged: false,
        },
      );

      expect(rendered.fileCount).toBe(1);
      expect(rendered.html).toContain("src/example.ts");
      expect(RegisteredCustomThemes.get("pierre-light")).not.toBe(brokenLoader);
      expect(RegisteredCustomThemes.get("pierre-dark")).not.toBe(brokenLoader);
    } finally {
      if (originalLightLoader) {
        RegisteredCustomThemes.set("pierre-light", originalLightLoader);
      } else {
        RegisteredCustomThemes.delete("pierre-light");
      }
      if (originalDarkLoader) {
        RegisteredCustomThemes.set("pierre-dark", originalDarkLoader);
      } else {
        RegisteredCustomThemes.delete("pierre-dark");
      }
      await disposeHighlighter();
    }
  });

  it("rejects patches that exceed file-count limits", async () => {
    const patch = Array.from({ length: 129 }, (_, i) => {
      return [
        `diff --git a/f${i}.ts b/f${i}.ts`,
        `--- a/f${i}.ts`,
        `+++ b/f${i}.ts`,
        "@@ -1 +1 @@",
        "-const x = 1;",
        "+const x = 2;",
      ].join("\n");
    }).join("\n");

    await expect(
      renderDiffDocument(
        {
          kind: "patch",
          patch,
        },
        {
          presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
          image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
          expandUnchanged: false,
        },
      ),
    ).rejects.toThrow("too many files");
  });
});

describe("viewer assets", () => {
  it("prefers the built plugin asset layout when present", async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === "/repo/dist/extensions/diffs/assets/viewer-runtime.js") {
        return { mtimeMs: 1 };
      }
      const error = Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      throw error;
    });

    await expect(
      resolveViewerRuntimeFileUrl({
        baseUrl: "file:///repo/dist/extensions/diffs/index.js",
        stat,
      }),
    ).resolves.toMatchObject({
      pathname: "/repo/dist/extensions/diffs/assets/viewer-runtime.js",
    });
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("falls back to the source asset layout when the built artifact is absent", async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === "/repo/extensions/diffs/assets/viewer-runtime.js") {
        return { mtimeMs: 1 };
      }
      const error = Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      throw error;
    });

    await expect(
      resolveViewerRuntimeFileUrl({
        baseUrl: "file:///repo/extensions/diffs/src/viewer-assets.js",
        stat,
      }),
    ).resolves.toMatchObject({
      pathname: "/repo/extensions/diffs/assets/viewer-runtime.js",
    });
    expect(stat).toHaveBeenNthCalledWith(1, "/repo/extensions/diffs/src/assets/viewer-runtime.js");
    expect(stat).toHaveBeenNthCalledWith(2, "/repo/extensions/diffs/assets/viewer-runtime.js");
  });

  it("serves a stable loader that points at the current runtime bundle", async () => {
    const loader = await getServedViewerAsset(VIEWER_LOADER_PATH);

    expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(loader?.body)).toContain(`./viewer-runtime.js?v=`);
  });

  it("serves the runtime bundle body", async () => {
    const runtime = await getServedViewerAsset(VIEWER_RUNTIME_PATH);

    expect(runtime?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(runtime?.body)).toContain("openclawDiffsReady");
    expect(String(runtime?.body)).toContain('style.width="24px"');
    expect(String(runtime?.body)).toContain('style.gap="6px"');
  });

  it("returns null for unknown asset paths", async () => {
    await expect(getServedViewerAsset("/plugins/diffs/assets/not-real.js")).resolves.toBeNull();
  });
});

describe("parseViewerPayloadJson", () => {
  function buildValidPayload(): Record<string, unknown> {
    return {
      prerenderedHTML: "<div>ok</div>",
      langs: ["text"],
      oldFile: {
        name: "README.md",
        contents: "before",
      },
      newFile: {
        name: "README.md",
        contents: "after",
      },
      options: {
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: ":host{}",
      },
    };
  }

  it("accepts valid payload JSON", () => {
    const parsed = parseViewerPayloadJson(JSON.stringify(buildValidPayload()));
    expect(parsed.options.diffStyle).toBe("unified");
    expect(parsed.options.diffIndicators).toBe("bars");
  });

  it("rejects payloads with invalid shape", () => {
    const broken = buildValidPayload();
    broken.options = {
      ...(broken.options as Record<string, unknown>),
      diffIndicators: "invalid",
    };

    expect(() => parseViewerPayloadJson(JSON.stringify(broken))).toThrow(
      "Diff payload has invalid shape.",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseViewerPayloadJson("{not-json")).toThrow("Diff payload is not valid JSON.");
  });
});
