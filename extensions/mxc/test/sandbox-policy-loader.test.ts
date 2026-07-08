import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadSandboxBaselinePolicy, readSandboxPolicyFile } from "../src/sandbox-policy-loader.js";

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-mxc-policy-"));
  testDirs.push(dir);
  return dir;
}

function writePolicy(path: string, policy: unknown): void {
  writeFileSync(path, `${JSON.stringify(policy)}\n`, "utf-8");
}

function expectPolicyFileFailure(policyPath: string, action: () => unknown, detail: string): void {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(policyPath);
    expect((err as Error).message).toContain(detail);
    return;
  }
  throw new Error("Expected policy loader failure.");
}

describe("loadSandboxBaselinePolicy", () => {
  test("resolves no configured policy files with the default baseline", () => {
    const policy = loadSandboxBaselinePolicy();

    expect(policy.filesystem.restrictToProjectDir).toBe(true);
    expect(policy.filesystem.additionalReadonlyPaths).toEqual([]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([]);
    expect(policy.process.timeoutSeconds).toBe(300);
    expect(policy.process.timeoutSecondsConfigured).toBe(false);
  });

  test("resolves missing configured policy files with the default baseline", () => {
    const dir = makeTestDir();
    const policyPaths = [
      join(dir, "missing-first-policy.json"),
      join(dir, "missing-second-policy.json"),
    ];

    const policy = loadSandboxBaselinePolicy({ policyPaths });

    expect(policy.filesystem.restrictToProjectDir).toBe(true);
    expect(policy.filesystem.additionalReadonlyPaths).toEqual([]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([]);
    expect(policy.process.timeoutSeconds).toBe(300);
    expect(policy.process.timeoutSecondsConfigured).toBe(false);
  });

  test("layers configured policy files in deterministic array order", () => {
    const dir = makeTestDir();
    const firstPolicyPath = join(dir, "first-policy.json");
    const secondPolicyPath = join(dir, "second-policy.json");
    writePolicy(firstPolicyPath, {
      filesystem: {
        additionalReadonlyPaths: ["/first-readonly"],
        additionalReadwritePaths: ["/first-write", "/shared-write"],
      },
      process: {
        timeoutSeconds: 90,
      },
    });
    writePolicy(secondPolicyPath, {
      filesystem: {
        additionalReadonlyPaths: ["/second-readonly"],
        additionalReadwritePaths: ["/second-write", "/shared-write"],
      },
      process: {
        timeoutSeconds: 120,
      },
    });

    const policy = loadSandboxBaselinePolicy({ policyPaths: [firstPolicyPath, secondPolicyPath] });

    expect(policy.filesystem.additionalReadonlyPaths).toEqual([
      "/first-readonly",
      "/second-readonly",
    ]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([
      "/first-write",
      "/shared-write",
      "/second-write",
    ]);
    expect(policy.process.timeoutSeconds).toBe(90);
    expect(policy.process.timeoutSecondsConfigured).toBe(true);
  });

  test("hardening booleans can only remain restrictive", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "policy.json");
    writePolicy(policyPath, {
      filesystem: {
        restrictToProjectDir: false,
      },
    });

    expect(() => loadSandboxBaselinePolicy({ policyPaths: [policyPath] })).toThrow(
      /restrictToProjectDir/u,
    );
  });
});

describe("readSandboxPolicyFile", () => {
  test("returns undefined for missing files", () => {
    expect(readSandboxPolicyFile(join(makeTestDir(), "missing.json"))).toBeUndefined();
  });

  test("fails closed with path-inclusive errors for malformed existing files", () => {
    const dir = makeTestDir();
    const cases: ReadonlyArray<{
      name: string;
      content: string;
      detail: string;
    }> = [
      {
        name: "invalid-json.json",
        content: "{",
        detail: "Failed to load sandbox policy file at",
      },
      {
        name: "array.json",
        content: "[]",
        detail: "must be a JSON object",
      },
      {
        name: "unknown-key.json",
        content: JSON.stringify({ network: { additionalDeniedHosts: ["metadata"] } }),
        detail: "is not supported",
      },
    ];

    for (const item of cases) {
      const policyPath = join(dir, item.name);
      writeFileSync(policyPath, item.content, "utf-8");

      expectPolicyFileFailure(policyPath, () => readSandboxPolicyFile(policyPath), item.detail);
    }
  });
});
