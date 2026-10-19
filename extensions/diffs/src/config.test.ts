import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { diffsPluginConfigSchema, resolveDiffsPluginDefaults } from "./config.js";
import { ensureCuratedViewerRuntimeForTests } from "./test-helpers.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";
import {
  getServedLanguagePackViewerAsset,
  LANGUAGE_PACK_VIEWER_ASSET_PREFIX,
} from "./viewer-assets.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

beforeAll(ensureCuratedViewerRuntimeForTests);

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: JsonSchemaObject };

function validateManifest(value: unknown) {
  return validateJsonSchemaValue({
    cacheKey: "diffs.manifest.config.test",
    schema: manifest.configSchema,
    value,
    applyDefaults: true,
  });
}

const requireRecord = createRequireRecord("object", "expected-label");
const parseConfig = (value: unknown) =>
  requireRecord(diffsPluginConfigSchema.safeParse?.(value), "parse result");

it("accepts image* config aliases for backward compatibility", () => {
  expect(
    resolveDiffsPluginDefaults({
      defaults: { imageFormat: "pdf", imageQuality: "hq", imageScale: 2.2, imageMaxWidth: 1024 },
    }),
  ).toMatchObject({
    fileFormat: "pdf",
    fileQuality: "hq",
    fileScale: 2.2,
    fileMaxWidth: 1024,
  });
});
describe("diffs plugin schema surfaces", () => {
  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    expect(diffsPluginConfigSchema.jsonSchema).toEqual(manifest.configSchema);
  });

  it("rejects invalid viewerBaseUrl values at manifest-validation time too", () => {
    expect(validateManifest({ viewerBaseUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateManifest({ viewerBaseUrl: "https://example.com/openclaw?x=1" }).ok).toBe(false);
    expect(validateManifest({ viewerBaseUrl: "https://example.com/openclaw#frag" }).ok).toBe(false);
    expect(validateManifest({ viewerBaseUrl: "https://example.com/openclaw/" }).ok).toBe(true);
  });

  it("preserves defaults and security for direct safeParse callers", () => {
    const parsed = parseConfig({
      viewerBaseUrl: "https://example.com/openclaw/",
      defaults: { theme: "light", ttlSeconds: 21_600 },
      security: { allowRemoteViewer: true },
    });
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
    const parsed = parseConfig({ defaults: { format: "pdf", imageQuality: "hq" } });
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
    const parsed = parseConfig({ viewerBaseUrl: "javascript:alert(1)" });
    expect(parsed.success).toBe(false);
    const error = requireRecord(parsed.error, "parse error");
    const issues = error.issues as Array<{ path?: unknown; message?: unknown }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["viewerBaseUrl"],
      message: "viewerBaseUrl must use http or https: javascript:alert(1)",
    });
  });
});

describe("diffs viewer URL helpers", () => {
  it("resolves explicit, plugin, public, then bind-aware viewer bases", () => {
    const viewerPath = "/plugins/diffs/view/id/token";
    const publicConfig = { gateway: { publicOrigin: "https://public.example.com" } };
    const expectBase = (
      base: string,
      options: Partial<Omit<Parameters<typeof buildViewerUrl>[0], "viewerPath">> = {},
    ) =>
      expect(buildViewerUrl({ config: publicConfig, ...options, viewerPath })).toBe(
        `${base}${viewerPath}`,
      );
    expectBase("https://explicit.example.com/review", {
      baseUrl: "https://explicit.example.com/review",
      viewerBaseUrl: "https://plugin.example.com/viewer",
    });
    expectBase("https://plugin.example.com/viewer", {
      viewerBaseUrl: "https://plugin.example.com/viewer",
    });
    expectBase("https://public.example.com");
    expectBase("https://gateway.example.com", {
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.example.com",
          port: 443,
          tls: { enabled: true },
        },
      },
    });
  });

  it("rejects base URLs with query/hash", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
      "baseUrl must not include query/hash",
    );
    expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
      "baseUrl must not include query/hash",
    );
  });
});

it("serves the optional language-pack loader only when its generated runtime is present", async () => {
  const loader = await getServedLanguagePackViewerAsset(
    `${LANGUAGE_PACK_VIEWER_ASSET_PREFIX}viewer.js`,
  );

  if (!loader) {
    expect(loader).toBeNull();
    return;
  }
  expect(loader.contentType).toBe("text/javascript; charset=utf-8");
  expect(String(loader.body)).toContain(`./viewer-runtime.js?v=`);
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
