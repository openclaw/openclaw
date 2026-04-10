#!/usr/bin/env tsx
/**
 * Copy the Octopus registry schema.sql from src to dist so the bundled
 * migrate module can find it at runtime via import.meta.url resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

const src = path.join(context.projectRoot, "src", "octo", "head", "storage", "schema.sql");
const dest = path.join(context.projectRoot, "dist", "schema.sql");

if (!fs.existsSync(src)) {
  console.log(`${context.prefix} schema.sql not found (octo not present); skipping.`);
  process.exit(0);
}

fs.copyFileSync(src, dest);
console.log(`${context.prefix} Copied octo schema.sql to dist/.`);
