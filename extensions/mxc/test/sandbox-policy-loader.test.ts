import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadSandboxBaselinePolicy } from "../src/sandbox-policy-loader.js";

const describeOnWindows = describe.runIf(process.platform === "win32");

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

function makeExistingDir(rootDir: string, name: string): string {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePolicy(policy: unknown): string {
  const policyPath = join(makeTestDir(), "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy), "utf-8");
  return policyPath;
}

const loadPolicy = (...policyPaths: string[]) => loadSandboxBaselinePolicy({ policyPaths });

function expectPolicyFileFailure(policyPath: string, detail: string): void {
  try {
    loadPolicy(policyPath);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(policyPath);
    expect((err as Error).message).toContain(detail);
    return;
  }
  throw new Error("Expected policy loader failure.");
}

test.each([0, null])("rejects invalid timeout %s at policy admission", (timeoutSeconds) => {
  const policyPath = writePolicy({ process: { timeoutSeconds } });
  expect(() => loadPolicy(policyPath)).toThrow(/timeoutSeconds/u);
});

describeOnWindows("loadSandboxBaselinePolicy", () => {
  test("fails closed when a configured policy file is missing", () => {
    const missingPolicyPath = join(makeTestDir(), "missing-policy.json");

    expect(() => loadPolicy(missingPolicyPath)).toThrow(/does not exist/u);
  });

  test("layers configured policy files in deterministic array order", () => {
    const dir = makeTestDir();
    const firstReadonlyPath = makeExistingDir(dir, "readonly-first");
    const secondReadonlyPath = makeExistingDir(dir, "readonly-second");
    const firstReadwritePath = makeExistingDir(dir, "readwrite-first");
    const sharedReadwritePath = makeExistingDir(dir, "readwrite-shared");
    const secondReadwritePath = makeExistingDir(dir, "readwrite-second");

    const firstPolicyPath = writePolicy({
      filesystem: {
        additionalReadonlyPaths: [`  ${firstReadonlyPath}  `],
        additionalReadwritePaths: [firstReadwritePath, sharedReadwritePath],
      },
      process: { timeoutSeconds: 90 },
    });
    const secondPolicyPath = writePolicy({
      filesystem: {
        additionalReadonlyPaths: [secondReadonlyPath],
        additionalReadwritePaths: [secondReadwritePath, sharedReadwritePath],
      },
      process: { timeoutSeconds: 120 },
    });

    const policy = loadPolicy(firstPolicyPath, secondPolicyPath);

    expect(policy.configuredPaths.readonlyPaths.map((entry) => entry.path)).toEqual([
      firstReadonlyPath,
      secondReadonlyPath,
    ]);
    expect(policy.configuredPaths.readwritePaths).toEqual([
      {
        path: firstReadwritePath,
        sources: [`${firstPolicyPath}.filesystem.additionalReadwritePaths[0]`],
      },
      {
        path: sharedReadwritePath,
        sources: [
          `${firstPolicyPath}.filesystem.additionalReadwritePaths[1]`,
          `${secondPolicyPath}.filesystem.additionalReadwritePaths[1]`,
        ],
      },
      {
        path: secondReadwritePath,
        sources: [`${secondPolicyPath}.filesystem.additionalReadwritePaths[0]`],
      },
    ]);
    expect(policy.process.timeoutSeconds).toBe(90);
  });

  test("hardening booleans can only remain restrictive", () => {
    const policyPath = writePolicy({
      filesystem: { restrictToProjectDir: false },
    });

    expect(() => loadPolicy(policyPath)).toThrow(/restrictToProjectDir/u);
  });

  test.each([
    ["blank read-only", "additionalReadonlyPaths", "   ", "must not be blank"],
    ["relative read-write", "additionalReadwritePaths", "relative\\path", "absolute Windows path"],
    ["nonexistent read-only", "additionalReadonlyPaths", null, "does not exist on the host"],
  ] as const)("fails closed for %s paths", (_name, field, value, detail) => {
    const policyPath = writePolicy({
      filesystem: { [field]: [value ?? join(makeTestDir(), "missing-readonly")] },
    });
    expectPolicyFileFailure(policyPath, detail);
  });

  test("fails closed with path-inclusive errors for malformed existing files", () => {
    const dir = makeTestDir();
    const cases = [
      ["invalid-json.json", "{", "Failed to load sandbox policy file at"],
      ["array.json", "[]", "must be a JSON object"],
      [
        "unknown-key.json",
        JSON.stringify({ network: { additionalDeniedHosts: ["metadata"] } }),
        "is not supported",
      ],
    ] as const;

    for (const [name, content, detail] of cases) {
      const policyPath = join(dir, name);
      writeFileSync(policyPath, content, "utf-8");
      expectPolicyFileFailure(policyPath, detail);
    }
  });
});
