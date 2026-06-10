#!/usr/bin/env node

// Fast diagnostics gate for tsdown-build wrapper-only contracts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTsdownConfigIndexFile,
  parseTsdownBuildArgs,
  tsdownBuildUsage,
} from "./tsdown-build.mjs";

assert.deepEqual(parseTsdownBuildArgs(["--help"]), {
  forwardedArgs: [],
  help: true,
  configIndex: null,
  allowIneffectiveDynamicImport: false,
});
assert.deepEqual(parseTsdownBuildArgs(["--format", "esm"]), {
  forwardedArgs: ["--format", "esm"],
  help: false,
  configIndex: null,
  allowIneffectiveDynamicImport: false,
});
assert.deepEqual(parseTsdownBuildArgs(["--config-index", "16", "--logLevel", "info"]), {
  forwardedArgs: ["--logLevel", "info"],
  help: false,
  configIndex: 16,
  allowIneffectiveDynamicImport: false,
});
assert.deepEqual(
  parseTsdownBuildArgs([
    "--config-index",
    "16",
    "--allow-ineffective-dynamic-import",
    "--logLevel",
    "info",
  ]),
  {
    forwardedArgs: ["--logLevel", "info"],
    help: false,
    configIndex: 16,
    allowIneffectiveDynamicImport: true,
  },
);
assert.throws(
  () => parseTsdownBuildArgs(["--config-index"]),
  /--config-index requires a non-negative integer value/u,
);
assert.throws(
  () => parseTsdownBuildArgs(["--config-index", "1", "--config-index", "2"]),
  /--config-index can only be passed once/u,
);

const usage = tsdownBuildUsage();
assert.match(usage, /--config-index <number>/u);
assert.match(usage, /--allow-ineffective-dynamic-import/u);

const helpResult = spawnSync(process.execPath, ["scripts/tsdown-build.mjs", "--help"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
assert.equal(helpResult.status, 0);
assert.match(helpResult.stdout, /--config-index <number>/u);
assert.equal(helpResult.stderr, "");

const invalidArgResult = spawnSync(
  process.execPath,
  ["scripts/tsdown-build.mjs", "--config-index"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);
assert.equal(invalidArgResult.status, 2);
assert.match(invalidArgResult.stderr, /--config-index requires a non-negative integer value/u);
assert.match(invalidArgResult.stderr, /Other arguments are forwarded to tsdown/u);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tsdown-config-index-"));
try {
  const fileName = createTsdownConfigIndexFile({ cwd: tempDir, configIndex: 16 });
  assert.match(fileName, /^\.openclaw-tsdown-config-16-\d+-\d+\.ts$/u);
  assert.equal(
    fs.readFileSync(path.join(tempDir, fileName), "utf8"),
    'import configs from "./tsdown.config.ts";\nexport default configs[16];\n',
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const configText = fs.readFileSync("tsdown.config.ts", "utf8");
assert.match(configText, /OPENCLAW_RUN_ROOT_UNIFIED_DTS_BUILD/u);
assert.match(
  configText,
  /dts: RUN_NODE_SKIP_DTS_BUILD \|\| !RUN_ROOT_UNIFIED_DTS_BUILD \? false : undefined/u,
);

console.log("tsdown-build diagnostics: PASS");
