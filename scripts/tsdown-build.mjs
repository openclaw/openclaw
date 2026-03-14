#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Clean stale JS chunks from dist/ before rebuild.
// tsdown generates hashed chunk names; without cleanup, old chunks accumulate
// and can cause SyntaxError at runtime when Node loads a stale chunk whose
// sibling was recompiled with a different hash.
const distDir = join(process.cwd(), "dist");
try {
  for (const f of readdirSync(distDir)) {
    if (f.endsWith(".js") || f.endsWith(".js.map")) {
      unlinkSync(join(distDir, f));
    }
  }
} catch {
  // dist/ may not exist on first build
}

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const result = spawnSync(
  "pnpm",
  ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
