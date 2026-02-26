#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const swift = `// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: node scripts/generate-host-env-security-policy-swift.mjs

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

fs.writeFileSync(outputPath, swift);
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
