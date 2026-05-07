#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mjs";
import {
  applyLocalTsgoPolicy,
  getLocalNativeTypecheckRefusalError,
} from "./lib/local-heavy-check-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsgoPath = path.join(repoRoot, "node_modules", ".bin", "tsgo");

const coreGraphs = [
  { name: "core", config: "tsconfig.core.json" },
  { name: "core-test", config: "test/tsconfig/tsconfig.core.test.json" },
  { name: "core-test-agents", config: "test/tsconfig/tsconfig.core.test.agents.json" },
  { name: "core-test-non-agents", config: "test/tsconfig/tsconfig.core.test.non-agents.json" },
];

const coreBoundaryRefusalError = getLocalNativeTypecheckRefusalError({
  args: ["--listFilesOnly", ...coreGraphs.map((graph) => graph.config)],
  env: process.env,
  shouldRunHeavyCheck: true,
  toolName: "core boundary tsgo",
});
if (coreBoundaryRefusalError) {
  console.error(coreBoundaryRefusalError);
  process.exit(1);
}

function normalizeFilePath(filePath) {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function listGraphFiles(graph) {
  const policy = applyLocalTsgoPolicy(
    ["-p", graph.config, "--pretty", "false", "--listFilesOnly"],
    process.env,
  );
  const tsgo = createManagedCommandInvocation({
    args: policy.args,
    bin: tsgoPath,
  });
  const result = spawnSync(tsgo.command, tsgo.args, {
    cwd: repoRoot,
    env: policy.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: tsgo.shell,
    windowsVerbatimArguments: tsgo.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${graph.name} file listing failed with exit code ${result.status}\n${output}`);
  }
  return (result.stdout ?? "").split(/\r?\n/u).map(normalizeFilePath).filter(Boolean);
}

const violations = [];
for (const graph of coreGraphs) {
  const extensionFiles = listGraphFiles(graph).filter((file) => file.startsWith("extensions/"));
  for (const file of extensionFiles) {
    violations.push(`${graph.name}: ${file}`);
  }
}

if (violations.length > 0) {
  console.error("Core tsgo graphs must not include bundled extension files:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Move extension-owned behavior behind plugin SDK contracts, public artifacts, or extension-local tests.",
  );
  process.exit(1);
}
