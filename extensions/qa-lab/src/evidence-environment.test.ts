import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBunVersion } from "./runtime-version.test-support.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // Production consumes execFile's promisified, two-stream result.
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execFileMock }),
  execFileSync: execFileSyncMock,
}));

import {
  captureQaEvidenceLaunchIdentity,
  captureQaEvidenceSourceIdentity,
  resolveQaEvidenceEnvironment,
} from "./evidence-environment.js";

afterEach(async () => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
  await tempDirs.cleanup();
});

function mockGit(state: Record<string, string>) {
  execFileMock.mockImplementation(async (_command, args) => ({
    stdout: state[args[0]] ?? "actual-head\n",
    stderr: "",
  }));
}

describe("captured evidence source identity", () => {
  it("frames binary file contents separately from following untracked files", async () => {
    const root = await tempDirs.makeTempDir("qa-source-framing-");
    const state = { diff: "", "ls-files": "a\0b\0" };
    mockGit(state);
    await fs.writeFile(path.join(root, "a"), "first");
    await fs.writeFile(path.join(root, "b"), "second");
    const secondMode = (await fs.lstat(path.join(root, "b"))).mode;
    const separate = await captureQaEvidenceSourceIdentity(root);
    await fs.writeFile(path.join(root, "a"), `first\0b\0${secondMode}\0second`);
    await fs.unlink(path.join(root, "b"));
    state["ls-files"] = "a\0";
    const combined = await captureQaEvidenceSourceIdentity(root);

    expect(combined.gitSha).toBe(separate.gitSha);
    expect(combined.sourceDirty).toBe(true);
    expect(combined.sourcePatchSha256).not.toBe(separate.sourcePatchSha256);
  });

  it("binds dirty tracked and untracked bytes while retaining the actual committed ref", async () => {
    const root = await tempDirs.makeTempDir("qa-source-identity-");
    const state = { diff: "tracked change", "ls-files": "new.ts\0" };
    mockGit(state);
    await fs.writeFile(path.join(root, "new.ts"), "first");
    const first = await captureQaEvidenceSourceIdentity(root);
    expect(first).toMatchObject({ gitSha: "actual-head", sourceDirty: true });
    expect(first.sourcePatchSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await captureQaEvidenceSourceIdentity(root)).toEqual(first);
    await fs.writeFile(path.join(root, "new.ts"), "replacement");
    expect((await captureQaEvidenceSourceIdentity(root)).sourcePatchSha256).not.toBe(
      first.sourcePatchSha256,
    );
    state["ls-files"] = "";
    state.diff = "";
    expect(await captureQaEvidenceSourceIdentity(root)).toEqual({
      gitSha: "actual-head",
      sourceDirty: false,
      sourcePatchSha256: null,
    });
    expect((await captureQaEvidenceLaunchIdentity(root)).source).toEqual({
      ref: "actual-head",
      integrity: "git:actual-head",
    });
  });

  it("captures simulated Bun independently of available source identity", async () => {
    using _ = mockBunVersion("1.3.14");
    mockGit({ diff: "", "ls-files": "" });
    const identity = {
      runtime: { id: "bun", version: "1.3.14" },
    };
    expect(await captureQaEvidenceLaunchIdentity("fixture-checkout")).toMatchObject({
      ...identity,
      source: { ref: "actual-head", integrity: "git:actual-head" },
    });

    execFileMock.mockRejectedValue(new Error("source unavailable"));
    expect(await captureQaEvidenceLaunchIdentity("unavailable-checkout")).toMatchObject({
      source: { ref: null, integrity: null },
      ...identity,
    });
  });
});

describe("resolveQaEvidenceEnvironment", () => {
  it.each([
    [{ GITHUB_SHA: "fallbacksha" }, "fallbacksha"],
    [{}, null],
  ] as const)("falls back to environment %j when git fails", (env, ref) => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" });
    });
    expect(resolveQaEvidenceEnvironment({ env }).ref).toBe(ref);
  });
});
