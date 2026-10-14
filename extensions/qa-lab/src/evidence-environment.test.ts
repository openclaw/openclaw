// Qa Lab tests bound the evidence checkout ref git probe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBunVersion } from "./runtime-version.test-support.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  // Node's execFile promisify contract returns both streams, not just stdout.
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFileMock(...args, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  });
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
  };
});

import {
  captureQaEvidenceLaunchIdentity,
  captureQaEvidenceSourceIdentity,
  resolveQaEvidenceEnvironment,
} from "./evidence-environment.js";

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
});

describe("captured evidence source identity", () => {
  it("frames binary file contents separately from following untracked files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-source-framing-"));
    let untracked = "a\0b\0";
    execFileMock.mockImplementation((_command, args, _options, callback) =>
      callback(
        null,
        args[0] === "rev-parse" ? "actual-head\n" : args[0] === "diff" ? "" : untracked,
        "",
      ),
    );
    try {
      await fs.writeFile(path.join(root, "a"), "first");
      await fs.writeFile(path.join(root, "b"), "second");
      const secondMode = (await fs.lstat(path.join(root, "b"))).mode;
      const separate = await captureQaEvidenceSourceIdentity(root);
      await fs.writeFile(path.join(root, "a"), `first\0b\0${secondMode}\0second`);
      await fs.unlink(path.join(root, "b"));
      untracked = "a\0";
      const combined = await captureQaEvidenceSourceIdentity(root);

      expect(combined.gitSha).toBe(separate.gitSha);
      expect(combined.sourceDirty).toBe(true);
      expect(combined.sourcePatchSha256).not.toBe(separate.sourcePatchSha256);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds dirty tracked and untracked bytes while retaining the actual committed ref", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-source-identity-"));
    let patch = "tracked change";
    let untracked = "new.ts\0";
    execFileMock.mockImplementation((_command, args, _options, callback) =>
      callback(
        null,
        args[0] === "rev-parse" ? "actual-head\n" : args[0] === "diff" ? patch : untracked,
        "",
      ),
    );
    try {
      await fs.writeFile(path.join(root, "new.ts"), "first");
      const first = await captureQaEvidenceSourceIdentity(root);
      expect(first).toMatchObject({ gitSha: "actual-head", sourceDirty: true });
      expect(first.sourcePatchSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await captureQaEvidenceSourceIdentity(root)).toEqual(first);
      await fs.writeFile(path.join(root, "new.ts"), "replacement");
      expect((await captureQaEvidenceSourceIdentity(root)).sourcePatchSha256).not.toBe(
        first.sourcePatchSha256,
      );
      untracked = "";
      patch = "";
      expect(await captureQaEvidenceSourceIdentity(root)).toEqual({
        gitSha: "actual-head",
        sourceDirty: false,
        sourcePatchSha256: null,
      });
      expect((await captureQaEvidenceLaunchIdentity(root)).source).toEqual({
        ref: "actual-head",
        integrity: "git:actual-head",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([{ label: "simulated Bun", bun: "1.3.14", runtime: { id: "bun", version: "1.3.14" } }])(
    "captures $label independently of available source identity",
    async ({ bun, runtime }) => {
      using _ = mockBunVersion(bun);
      execFileMock.mockImplementation((_command, args, _options, callback) =>
        callback(null, args[0] === "rev-parse" ? "actual-head\n" : "", ""),
      );
      expect(await captureQaEvidenceLaunchIdentity("fixture-checkout")).toEqual({
        source: { ref: "actual-head", integrity: "git:actual-head" },
        runtime,
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      });

      execFileMock.mockImplementation((_command, _args, _options, callback) =>
        callback(new Error("source unavailable"), "", ""),
      );
      expect(await captureQaEvidenceLaunchIdentity("unavailable-checkout")).toEqual({
        source: { ref: null, integrity: null },
        runtime,
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      });
    },
  );
});

describe("resolveQaEvidenceEnvironment", () => {
  it("falls back to GITHUB_SHA when the git probe times out", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" });
    });

    const environment = resolveQaEvidenceEnvironment({ env: { GITHUB_SHA: "fallbacksha" } });

    expect(environment.ref).toBe("fallbacksha");
  });

  it("returns a null ref when the probe fails and no env fallback exists", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git unavailable");
    });

    const environment = resolveQaEvidenceEnvironment({ env: {} });

    expect(environment.ref).toBeNull();
  });
});
