import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, expect, it } from "vitest";
import { diffsPluginConfigSchema } from "./config.js";
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
  expect(parsed).toMatchObject({
    success: true,
    data: {
      viewerBaseUrl: "https://example.com/openclaw",
      security: { allowRemoteViewer: true },
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
        ttlSeconds: 21_600,
      },
    },
  });
});

it.each([
  ["imageFormat", 2.2, 1024, 2.2, 1024],
  ["format", undefined, undefined, 2.5, 1200],
] as const)("normalizes %s aliases", (field, imageScale, imageMaxWidth, scale, width) => {
  const parsed = parseConfig({
    defaults: { [field]: "pdf", imageQuality: "hq", imageScale, imageMaxWidth },
  });
  const file = { fileFormat: "pdf", fileQuality: "hq", fileScale: scale, fileMaxWidth: width };
  expect(parsed).toMatchObject({ success: true, data: { defaults: file } });
});

it("rejects invalid viewerBaseUrl config values", () => {
  const parsed = parseConfig({ viewerBaseUrl: "javascript:alert(1)" });
  expect(parsed).toMatchObject({
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
  expect(requireRecord(parsed.error, "parse error").issues).toHaveLength(1);
});
it("resolves explicit, plugin, public, then bind-aware viewer bases", () => {
  const url = (options: Partial<Parameters<typeof buildViewerUrl>[0]> = {}) =>
    buildViewerUrl({
      config: { gateway: { publicOrigin: "https://public.test" } },
      viewerPath: "/v",
      ...options,
    });
  expect(url({ baseUrl: "https://call/review", viewerBaseUrl: "https://plugin" })).toBe(
    "https://call/review/v",
  );
  expect(url({ viewerBaseUrl: "https://plugin.test" })).toBe("https://plugin.test/v");
  expect(url()).toBe("https://public.test/v");
  expect(
    url({
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "gw",
          port: 443,
          tls: { enabled: true },
        },
      },
    }),
  ).toBe("https://gw/v");
});

it("rejects base URLs with query/hash", () => {
  expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
    "baseUrl must not include query/hash",
  );
  expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
    "baseUrl must not include query/hash",
  );
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
