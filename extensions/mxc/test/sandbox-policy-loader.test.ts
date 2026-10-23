import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, test } from "vitest";
import { loadSandboxBaselinePolicy } from "../src/sandbox-policy-loader.js";

const describeOnWindows = describe.runIf(process.platform === "win32");

function writePolicy(root: string, name: string, policy: unknown): string {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(policy), "utf-8");
  return file;
}

function expectPolicyError(file: string, detail: string): void {
  try {
    loadSandboxBaselinePolicy({ policyPaths: [file] });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining(file) });
    expect(error).toMatchObject({ message: expect.stringContaining(detail) });
    return;
  }
  throw new Error("Expected policy loader failure.");
}

test.each([0, null])("rejects invalid timeout %s at policy admission", async (timeoutSeconds) => {
  await using workspace = await tempWorkspace({
    rootDir: tmpdir(),
    prefix: "openclaw-mxc-policy-",
  });
  const file = writePolicy(workspace.dir, "policy.json", { process: { timeoutSeconds } });
  expect(() => loadSandboxBaselinePolicy({ policyPaths: [file] })).toThrow(/timeoutSeconds/u);
});

describeOnWindows("sandbox policy admission", () => {
  test("fails closed for a missing policy file", async () => {
    await using workspace = await tempWorkspace({
      rootDir: tmpdir(),
      prefix: "openclaw-mxc-policy-",
    });
    expect(() =>
      loadSandboxBaselinePolicy({ policyPaths: [join(workspace.dir, "missing.json")] }),
    ).toThrow(/does not exist/u);
  });

  test("layers paths deterministically, retaining provenance and the smallest timeout", async () => {
    await using workspace = await tempWorkspace({
      rootDir: tmpdir(),
      prefix: "openclaw-mxc-policy-",
    });
    const directory = (name: string) => {
      const result = join(workspace.dir, name);
      mkdirSync(result);
      return result;
    };
    const ro1 = directory("readonly-first");
    const ro2 = directory("readonly-second");
    const rw1 = directory("readwrite-first");
    const shared = directory("readwrite-shared");
    const rw2 = directory("readwrite-second");
    const first = writePolicy(workspace.dir, "first.json", {
      filesystem: {
        additionalReadonlyPaths: [`  ${ro1}  `],
        additionalReadwritePaths: [rw1, shared],
      },
      process: { timeoutSeconds: 90 },
    });
    const second = writePolicy(workspace.dir, "second.json", {
      filesystem: {
        additionalReadonlyPaths: [ro2],
        additionalReadwritePaths: [rw2, shared],
      },
      process: { timeoutSeconds: 120 },
    });

    const policy = loadSandboxBaselinePolicy({ policyPaths: [first, second] });
    const source = (file: string, index: number) =>
      `${file}.filesystem.additionalReadwritePaths[${index}]`;
    expect(policy.configuredPaths.readonlyPaths.map((entry) => entry.path)).toEqual([ro1, ro2]);
    expect(policy.configuredPaths.readwritePaths).toEqual([
      { path: rw1, sources: [source(first, 0)] },
      { path: shared, sources: [source(first, 1), source(second, 1)] },
      { path: rw2, sources: [source(second, 0)] },
    ]);
    expect(policy.process.timeoutSeconds).toBe(90);
  });

  test("hardening cannot be disabled", async () => {
    await using workspace = await tempWorkspace({
      rootDir: tmpdir(),
      prefix: "openclaw-mxc-policy-",
    });
    const file = writePolicy(workspace.dir, "policy.json", {
      filesystem: { restrictToProjectDir: false },
    });
    expect(() => loadSandboxBaselinePolicy({ policyPaths: [file] })).toThrow(
      /restrictToProjectDir/u,
    );
  });

  test.each([
    ["blank read-only", "additionalReadonlyPaths", "   ", "must not be blank"],
    ["relative read-write", "additionalReadwritePaths", "relative\\path", "absolute Windows path"],
    ["nonexistent read-only", "additionalReadonlyPaths", null, "does not exist on the host"],
  ] as const)("fails closed for %s paths", async (_name, field, value, detail) => {
    await using workspace = await tempWorkspace({
      rootDir: tmpdir(),
      prefix: "openclaw-mxc-policy-",
    });
    const file = writePolicy(workspace.dir, "policy.json", {
      filesystem: {
        [field]: [value ?? join(workspace.dir, "missing-readonly")],
      },
    });
    expectPolicyError(file, detail);
  });

  test.each([
    ["{", "Failed to load sandbox policy file at"],
    ["[]", "must be a JSON object"],
    [JSON.stringify({ network: { additionalDeniedHosts: ["metadata"] } }), "is not supported"],
  ])("reports path-inclusive errors for malformed policy %s", async (content, detail) => {
    await using workspace = await tempWorkspace({
      rootDir: tmpdir(),
      prefix: "openclaw-mxc-policy-",
    });
    const file = join(workspace.dir, "policy.json");
    writeFileSync(file, content, "utf-8");
    expectPolicyError(file, detail);
  });
});
