#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write") || !checkOnly;

if (checkOnly && args.has("--write")) {
  console.error("Use either --check or --write, not both.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const policyPath = path.join(repoRoot, "src", "infra", "host-env-security-policy.json");
const outputPath = path.join(
  repoRoot,
  "apps",
  "macos",
  "Sources",
  "OpenClaw",
  "HostEnvSecurityPolicy.generated.swift",
);

/** @type {{blockedKeys: string[]; blockedOverrideKeys?: string[]; blockedPrefixes: string[]}} */
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));

const renderSwiftStringArray = (items) => items.map((item) => `        "${item}"`).join(",\n");

const generated = `// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: node scripts/generate-host-env-security-policy-swift.mjs --write

import Foundation

enum HostEnvSecurityPolicy {
    static let blockedKeys: Set<String> = [
${renderSwiftStringArray(policy.blockedKeys)}
    ]

    static let blockedOverrideKeys: Set<String> = [
${renderSwiftStringArray(policy.blockedOverrideKeys ?? [])}
    ]

    static let blockedPrefixes: [String] = [
${renderSwiftStringArray(policy.blockedPrefixes)}
    ]
}
`;

const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;

if (checkOnly) {
  if (current === generated) {
    console.log(`OK ${path.relative(repoRoot, outputPath)}`);
    process.exit(0);
  }
  console.error(
    [
      `Out of date ${path.relative(repoRoot, outputPath)}.`,
      "Run: node scripts/generate-host-env-security-policy-swift.mjs --write",
    ].join("\n"),
  );
  process.exit(1);
}

if (writeMode) {
  if (current !== generated) {
    fs.writeFileSync(outputPath, generated);
  }
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}
