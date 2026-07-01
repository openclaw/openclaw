import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadSandboxBaselinePolicy,
  readSandboxPolicyFile,
  resolveMachineSandboxPolicyPath,
  resolveUserSandboxPolicyPath,
} from "../src/sandbox-policy-loader.js";

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
  test("resolves missing policy files with the default baseline", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "missing-user-policy.json");
    const machinePolicyPath = join(dir, "missing-machine-policy.json");

    const policy = loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath });

    expect(policy.filesystem.restrictToProjectDir).toBe(true);
    expect(policy.filesystem.additionalReadonlyPaths).toEqual([]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([]);
    expect(policy.process.timeoutSeconds).toBe(300);
    expect(policy.process.timeoutSecondsConfigured).toBe(false);
  });

  test("layers user and machine policies in deterministic additive order", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "machine-policy.json");
    writePolicy(userPolicyPath, {
      filesystem: {
        additionalReadonlyPaths: ["/user-readonly"],
        additionalReadwritePaths: ["/user-write", "/shared-write"],
      },
      process: {
        timeoutSeconds: 90,
      },
    });
    writePolicy(machinePolicyPath, {
      filesystem: {
        additionalReadonlyPaths: ["/machine-readonly"],
        additionalReadwritePaths: ["/machine-write", "/shared-write"],
      },
      process: {
        timeoutSeconds: 120,
      },
    });

    const policy = loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath });

    expect(policy.filesystem.additionalReadonlyPaths).toEqual([
      "/user-readonly",
      "/machine-readonly",
    ]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([
      "/user-write",
      "/shared-write",
      "/machine-write",
    ]);
    expect(policy.process.timeoutSeconds).toBe(90);
    expect(policy.process.timeoutSecondsConfigured).toBe(true);
  });

  test("hardening booleans can only remain restrictive", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "machine-policy.json");
    writePolicy(userPolicyPath, {
      filesystem: {
        restrictToProjectDir: false,
      },
    });

    expect(() => loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath })).toThrow(
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

describe("policy path resolution", () => {
  test("uses OpenClaw policy locations", () => {
    expect(resolveUserSandboxPolicyPath("C:\\Users\\alice")).toContain(
      "C:\\Users\\alice\\.openclaw\\sandbox-policy.json",
    );
    expect(resolveMachineSandboxPolicyPath()).toBe(
      "C:\\ProgramData\\openclaw\\sandbox-policy.json",
    );
  });
});
