#!/usr/bin/env node

import fs from "node:fs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const SWIFT_CONTRACT_PATH =
  "apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift";
const SWIFT_FIXTURE_PATH =
  "apps/shared/OpenClawKit/Tests/OpenClawNativeStateTests/OpenClawNativeStateSQLiteTests.swift";
const TYPESCRIPT_CONTRACT_PATH = "src/state/openclaw-schema-versions.ts";

function extractSingleVersion(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} declaration; found ${matches.length}`);
  }
  return Number(matches[0][1]);
}

export function compareNativeStateSchemaVersions({
  swiftSource,
  typescriptSource,
  swiftFixtureSource,
}) {
  const swiftVersion = extractSingleVersion(
    swiftSource,
    /^\s*private static let maximumSupportedSchemaVersion: Int64 = (\d+)\s*$/gmu,
    "Swift maximumSupportedSchemaVersion",
  );
  const typescriptVersion = extractSingleVersion(
    typescriptSource,
    /^export const OPENCLAW_STATE_SCHEMA_VERSION = (\d+);\s*$/gmu,
    "TypeScript OPENCLAW_STATE_SCHEMA_VERSION",
  );
  if (swiftVersion !== typescriptVersion) {
    throw new Error(
      `Native state schema version drift: Swift supports ${swiftVersion}, TypeScript owns ${typescriptVersion}`,
    );
  }
  const fixtureVersion = extractSingleVersion(
    swiftFixtureSource,
    /^\s*private static let currentSharedSchemaVersion: Int64 = (\d+)\s*$/gmu,
    "Swift currentSharedSchemaVersion fixture",
  );
  if (fixtureVersion !== typescriptVersion) {
    throw new Error(
      `Native state schema fixture drift: Swift tests seed ${fixtureVersion}, TypeScript owns ${typescriptVersion}`,
    );
  }
  return swiftVersion;
}

export function checkNativeStateSchemaVersion(readFileSync = fs.readFileSync) {
  return compareNativeStateSchemaVersions({
    swiftSource: readFileSync(SWIFT_CONTRACT_PATH, "utf8"),
    typescriptSource: readFileSync(TYPESCRIPT_CONTRACT_PATH, "utf8"),
    swiftFixtureSource: readFileSync(SWIFT_FIXTURE_PATH, "utf8"),
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const version = checkNativeStateSchemaVersion();
    console.log(`native state schema version guard passed (v${version})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
