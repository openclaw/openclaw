#!/usr/bin/env node
// Trip if a future change re-adds `--config` to overlay/tenant/start.sh.
// `openclaw gateway` has no --config option; the rendered config path
// must be delivered via OPENCLAW_CONFIG_PATH. rockie-workspace#60.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TARGET = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "overlay",
  "tenant",
  "start.sh",
);

// Strip comment-only lines so the rationale comment that names --config
// is not a false positive.
const codeOnly = readFileSync(TARGET, "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

if (codeOnly.includes("--config")) {
  console.error(
    `check-tenant-config-path: \`--config\` reappeared in ${TARGET}.\n` +
      "The `openclaw gateway` CLI has no --config option; deliver the\n" +
      'rendered config via `export OPENCLAW_CONFIG_PATH="$RENDERED"`\n' +
      "before the exec. Refs: rockie-workspace#60.",
  );
  process.exitCode = 1;
}
