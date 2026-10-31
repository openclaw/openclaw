import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it } from "vitest";
import { diffsPluginConfigSchema, resolveDiffsPluginDefaults } from "./config.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: JsonSchemaObject };
function parseData(value: unknown) {
  const parsed = diffsPluginConfigSchema.safeParse!(value);
  expect(parsed.success).toBe(true);
  return parsed.data;
}
const validate = (value: unknown) =>
  validateJsonSchemaValue({
    cacheKey: "diffs.manifest.config.test",
    schema: manifest.configSchema,
    value,
    applyDefaults: true,
  }).ok;

it.each([
  [
    { imageFormat: "pdf", imageQuality: "hq", imageScale: 2.2, imageMaxWidth: 1024 },
    { fileFormat: "pdf", fileQuality: "hq", fileScale: 2.2, fileMaxWidth: 1024 },
  ],
  [
    { format: "pdf", imageQuality: "hq" },
    { fileFormat: "pdf", fileQuality: "hq", fileScale: 2.5, fileMaxWidth: 1200 },
  ],
])("resolves config aliases before applying defaults: %j", (defaults, expected) => {
  expect(resolveDiffsPluginDefaults({ defaults })).toMatchObject(expected);
  expect(parseData({ defaults })).toMatchObject({ defaults: expected });
});

it("keeps the runtime json schema in sync with the manifest config schema", () => {
  expect(diffsPluginConfigSchema.jsonSchema).toEqual(manifest.configSchema);
});

it.each([
  ["javascript:alert(1)", "must use http or https"],
  ["https://example.com/openclaw?x=1", "must not include query/hash"],
  ["https://example.com/openclaw#frag", "must not include query/hash"],
])("rejects invalid viewer base %s at both schema surfaces", (viewerBaseUrl, message) => {
  const value = { viewerBaseUrl };
  expect(validate(value)).toBe(false);
  expect(() => normalizeViewerBaseUrl(viewerBaseUrl)).toThrow(message);
  expect(diffsPluginConfigSchema.safeParse!(value)).toMatchObject({
    success: false,
    error: {
      issues: [{ path: ["viewerBaseUrl"], message: `viewerBaseUrl ${message}: ${viewerBaseUrl}` }],
    },
  });
});

it("preserves defaults and security for direct safeParse callers", () => {
  expect(validate({ viewerBaseUrl: "https://example.com/openclaw/" })).toBe(true);
  expect(
    parseData({
      viewerBaseUrl: "https://example.com/openclaw/",
      defaults: { theme: "light", ttlSeconds: 21_600 },
      security: { allowRemoteViewer: true },
    }),
  ).toMatchObject({
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
  });
});
const publicConfig = { gateway: { publicOrigin: "https://public.example.com" } };
it.each([
  [publicConfig, "https://plugin.example.com/viewer", "https://plugin.example.com/viewer"],
  [publicConfig, undefined, "https://public.example.com"],
  [
    {
      gateway: {
        bind: "custom",
        customBindHost: "gateway.example.com",
        port: 443,
        tls: { enabled: true },
      },
    },
    undefined,
    "https://gateway.example.com",
  ],
] as const)("resolves configured viewer base %j", (config, viewerBaseUrl, base) => {
  const viewerPath = "/plugins/diffs/view/id/token";
  expect(buildViewerUrl({ config, viewerBaseUrl, viewerPath })).toBe(`${base}${viewerPath}`);
});
