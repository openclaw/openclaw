#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Pnpm retains root dependencies for root-owned release helpers. Select only
// the additional workspace closures needed by cold native asset generation.
execFileSync(
  "pnpm",
  [
    "install",
    "--filter",
    "@openclaw/mermaid-renderer...",
    "--filter",
    "@openclaw/gateway-protocol...",
    "--frozen-lockfile",
    "--prefer-offline",
    "--optional",
    "--config.ignore-scripts=false",
    "--config.engine-strict=false",
    "--config.enable-pre-post-scripts=true",
    "--config.side-effects-cache=true",
  ],
  { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" },
);
