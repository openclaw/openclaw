import fs from "node:fs";
import path from "node:path";
import { pluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mjs";

const RUNTIME_SHIMS: Partial<Record<string, string>> = {
  "secret-input-runtime": [
    "export {",
    "  hasConfiguredSecretInput,",
    "  normalizeResolvedSecretInputString,",
    "  normalizeSecretInputString,",
    '} from "./config-runtime.js";',
    "",
  ].join("\n"),
  "webhook-path": [
    "/** Normalize webhook paths into the canonical registry form used by route lookup. */",
    "export function normalizeWebhookPath(raw) {",
    "  const trimmed = raw.trim();",
    "  if (!trimmed) {",
    '    return "/";',
    "  }",
    '  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;',
    '  if (withSlash.length > 1 && withSlash.endsWith("/")) {',
    "    return withSlash.slice(0, -1);",
    "  }",
    "  return withSlash;",
    "}",
    "",
    "/** Resolve the effective webhook path from explicit path, URL, or default fallback. */",
    "export function resolveWebhookPath(params) {",
    "  const trimmedPath = params.webhookPath?.trim();",
    "  if (trimmedPath) {",
    "    return normalizeWebhookPath(trimmedPath);",
    "  }",
    "  if (params.webhookUrl?.trim()) {",
    "    try {",
    "      const parsed = new URL(params.webhookUrl);",
    '      return normalizeWebhookPath(parsed.pathname || "/");',
    "    } catch {",
    "      return null;",
    "    }",
    "  }",
    "  return params.defaultPath ?? null;",
    "}",
    "",
  ].join("\n"),
};

const TYPE_SHIMS: Partial<Record<string, string>> = {
  "secret-input-runtime": [
    "export {",
    "  hasConfiguredSecretInput,",
    "  normalizeResolvedSecretInputString,",
    "  normalizeSecretInputString,",
    '} from "./config-runtime.js";',
    "",
  ].join("\n"),
};

const GENERATED_FACADE_TYPE_MAP_SOURCE = path.join(
  process.cwd(),
  "dist/plugin-sdk/src/generated/plugin-sdk-facade-type-map.generated.d.ts",
);
const GENERATED_FACADE_TYPE_MAP_DIST_PREFIX = "../../../extensions/";

function rewriteFacadeTypeMapSpecifier(specifier: string): string {
  if (!specifier.startsWith("@openclaw/")) {
    return specifier;
  }
  return `${GENERATED_FACADE_TYPE_MAP_DIST_PREFIX}${specifier.slice("@openclaw/".length)}`;
}

function rewriteGeneratedFacadeTypeMapDts(): void {
  if (!fs.existsSync(GENERATED_FACADE_TYPE_MAP_SOURCE)) {
    return;
  }
  const source = fs.readFileSync(GENERATED_FACADE_TYPE_MAP_SOURCE, "utf8");
  const rewritten = source.replace(/@openclaw\/([a-z0-9-]+\/[^")\s]+)/g, (_match, suffix: string) =>
    rewriteFacadeTypeMapSpecifier(`@openclaw/${suffix}`),
  );
  if (rewritten !== source) {
    fs.writeFileSync(GENERATED_FACADE_TYPE_MAP_SOURCE, rewritten, "utf8");
  }
}

// `tsc` emits declarations under `dist/plugin-sdk/src/plugin-sdk/*` because the source lives
// at `src/plugin-sdk/*` and `rootDir` is `.` (repo root, to support cross-src/extensions refs).
//
// Our package export map points subpath `types` at `dist/plugin-sdk/<entry>.d.ts`, so we
// generate stable entry d.ts files that re-export the real declarations.
for (const entry of pluginSdkEntrypoints) {
  const typeOut = path.join(process.cwd(), `dist/plugin-sdk/${entry}.d.ts`);
  fs.mkdirSync(path.dirname(typeOut), { recursive: true });
  fs.writeFileSync(
    typeOut,
    TYPE_SHIMS[entry] ?? `export * from "./src/plugin-sdk/${entry}.js";\n`,
    "utf8",
  );

  const runtimeShim = RUNTIME_SHIMS[entry];
  if (!runtimeShim) {
    continue;
  }
  const runtimeOut = path.join(process.cwd(), `dist/plugin-sdk/${entry}.js`);
  fs.mkdirSync(path.dirname(runtimeOut), { recursive: true });
  fs.writeFileSync(runtimeOut, runtimeShim, "utf8");
}

rewriteGeneratedFacadeTypeMapDts();
