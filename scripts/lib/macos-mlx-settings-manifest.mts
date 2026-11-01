import assert from "node:assert/strict";

export const mlxSettingsManifestPath = "apps/macos/Package.swift";
const targetName = "OpenClawIPCTests";
const testSources = ["MLXSettingsUpgradeTests.swift"];

export function projectMlxSettingsManifest(original: string): string {
  const target = `.testTarget(\n            name: "${targetName}",\n`;
  const start = original.indexOf(target);
  assert(start >= 0 && !original.includes(target, start + 1), "Ambiguous settings test target");
  const settings = original.indexOf("            swiftSettings: [", start);
  assert(settings > start, "Settings test target has no compiler settings");
  const body = original.slice(start + target.length, settings);
  assert(
    body.startsWith("            dependencies: [\n") &&
      body.endsWith("            ],\n") &&
      !body.includes(".testTarget(") &&
      !/\bsources\s*:/u.test(body),
    "Unsupported settings test target layout",
  );
  return (
    original.slice(0, settings) +
    `            sources: ["${testSources[0]}"],\n` +
    original.slice(settings)
  );
}

export function verifyMlxSettingsPackageProjection(
  original: Record<string, unknown>,
  projected: Record<string, unknown>,
): void {
  const expected = structuredClone(original);
  assert(Array.isArray(expected.targets), "Missing Swift package targets");
  const targets = expected.targets.filter(
    (target): target is Record<string, unknown> =>
      target !== null && typeof target === "object" && target.name === targetName,
  );
  assert.equal(targets.length, 1, "Ambiguous Swift package settings target");
  const target = targets[0]!;
  assert(target.sources == null, "Settings target already selects test sources");
  target.sources = testSources;
  assert.deepEqual(projected, expected, "Settings projection changed the Swift package graph");
}
