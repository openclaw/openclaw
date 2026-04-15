#!/usr/bin/env -S node --import tsx

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NPM_UPDATE_COMPAT_SIDECARS } from "../src/infra/npm-update-compat-sidecars.ts";

export function writeNpmUpdateCompatSidecars(): void {
  for (const entry of NPM_UPDATE_COMPAT_SIDECARS) {
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    fs.writeFileSync(entry.path, entry.content, "utf8");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeNpmUpdateCompatSidecars();
}
