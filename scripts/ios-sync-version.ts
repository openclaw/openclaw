#!/usr/bin/env -S node --import tsx

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type CliOptions = {
  buildNumber: string;
  version: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options.set(key, value);
    i += 1;
  }

  const version = options.get("version")?.trim();
  const buildNumber = options.get("build-number")?.trim();

  if (!version) {
    throw new Error("Missing required --version");
  }
  if (!buildNumber) {
    throw new Error("Missing required --build-number");
  }
  if (!/^[0-9]+$/.test(buildNumber)) {
    throw new Error(`Invalid --build-number '${buildNumber}'; expected digits only.`);
  }

  return { buildNumber, version };
}

function toShortVersion(input: string): string {
  const trimmed = input.trim().replace(/^v/, "");
  const shortVersion = trimmed.replace(/([.-]?beta[.-]\d+)$/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(shortVersion)) {
    throw new Error(
      `Invalid --version '${input}'; expected CalVer like 2026.3.9 or 2026.3.9-beta.1.`,
    );
  }
  return shortVersion;
}

function replaceAllExact(params: { content: string; pattern: RegExp; replacement: string }) {
  const { content, pattern, replacement } = params;
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(`Pattern not found: ${pattern}`);
  }
  return content.replace(pattern, replacement);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const shortVersion = toShortVersion(options.version);
  const projectPath = resolve("apps/ios/project.yml");
  const original = readFileSync(projectPath, "utf8");

  let updated = original;
  updated = replaceAllExact({
    content: updated,
    pattern: /(CFBundleShortVersionString:\s*")[^"]+(")/g,
    replacement: `$1${shortVersion}$2`,
  });
  updated = replaceAllExact({
    content: updated,
    pattern: /(CFBundleVersion:\s*")[^"]+(")/g,
    replacement: `$1${options.buildNumber}$2`,
  });

  if (updated === original) {
    console.log(`iOS version already set: short=${shortVersion} build=${options.buildNumber}`);
    return;
  }

  writeFileSync(projectPath, updated);
  console.log(`Updated iOS project version: short=${shortVersion} build=${options.buildNumber}`);
}

try {
  main();
} catch (error) {
  console.error(`ios-sync-version: ${(error as Error).message}`);
  process.exit(1);
}
