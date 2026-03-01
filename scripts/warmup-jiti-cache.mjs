#!/usr/bin/env node
/**
 * Pre-warms the jiti filesystem cache by transpiling all bundled plugin files.
 * Run during `docker build` so the transpiled output is baked into the image.
 *
 * jiti caches to `node_modules/.cache/jiti` when explicitly configured.
 * (jiti's auto-detection breaks with file:// URLs, falling back to /tmp.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Use the same cache dir that loader.ts resolves to at runtime
const jitiCacheDir = path.join(root, "node_modules", ".cache", "jiti");
fs.mkdirSync(jitiCacheDir, { recursive: true });

// Resolve the plugin SDK alias the same way loader.ts does
const isProduction = process.env.NODE_ENV === "production";

function findSdkAlias(srcFile, distFile) {
  for (let cursor = root, i = 0; i < 3; i++) {
    const srcCandidate = path.join(cursor, "src", "plugin-sdk", srcFile);
    const distCandidate = path.join(cursor, "dist", "plugin-sdk", distFile);
    const candidates = isProduction ? [distCandidate, srcCandidate] : [srcCandidate, distCandidate];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

const sdkAlias = findSdkAlias("index.ts", "index.js");
const sdkAccountIdAlias = findSdkAlias("account-id.ts", "account-id.js");

const alias = {
  ...(sdkAlias ? { "openclaw/plugin-sdk": sdkAlias } : {}),
  ...(sdkAccountIdAlias ? { "openclaw/plugin-sdk/account-id": sdkAccountIdAlias } : {}),
};

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  fsCache: jitiCacheDir,
  extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  ...(Object.keys(alias).length > 0 ? { alias } : {}),
});

// Find and transpile all bundled extension files
const extensionsDir = path.join(root, "extensions");
let warmed = 0;
let failed = 0;

if (fs.existsSync(extensionsDir)) {
  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extDir = path.join(extensionsDir, entry.name);
    for (const indexName of ["index.ts", "index.js"]) {
      const indexPath = path.join(extDir, indexName);
      if (fs.existsSync(indexPath)) {
        try {
          jiti(indexPath);
          warmed++;
          console.log(`  warmed: ${entry.name}/${indexName}`);
        } catch (err) {
          failed++;
          console.warn(
            `  skip: ${entry.name}/${indexName} (${err.message?.split("\n")[0] ?? err})`,
          );
        }
        break;
      }
    }
  }
}

console.log(`jiti cache warmed: ${warmed} plugins (${failed} skipped)`);

// Verify cache was written
const cacheFiles = fs.readdirSync(jitiCacheDir).length;
console.log(`jiti cache files: ${cacheFiles} in ${jitiCacheDir}`);
