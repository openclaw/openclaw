import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitLocalCoderArtifact,
  ensureSharedLocalCoderScratch,
  isPathInsideRoot,
  resolveLocalCoderScratchRoots,
  validateLocalCoderArtifactPath,
  verifyHostVisibleLocalCoderArtifact,
} from "./local-coder-artifacts.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-coder artifacts", () => {
  it("validates paths and rejects escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-coder-"));
    tempRoots.push(root);
    expect(isPathInsideRoot(join(root, "ok.txt"), root)).toBe(true);
    expect(() =>
      validateLocalCoderArtifactPath(join(root, "..", "escape"), { hostScratchRoot: root }),
    ).toThrow();
  });

  it("maps coder scratch to host scratch", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-coder-"));
    tempRoots.push(root);
    const roots = resolveLocalCoderScratchRoots({
      hostScratchRoot: join(root, "host"),
      coderWorkspaceRoot: join(root, "coder"),
    });
    await ensureSharedLocalCoderScratch(roots);
    await writeFile(join(roots.coderScratchRoot, "result.txt"), "shared");
    await expect(readFile(join(roots.hostScratchRoot, "result.txt"), "utf8")).resolves.toBe(
      "shared",
    );
  });

  it("atomically commits and verifies a host artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-coder-"));
    tempRoots.push(root);
    const sourcePath = join(root, "source.txt");
    const hostScratchRoot = join(root, "host");
    const hostArtifactPath = join(hostScratchRoot, "result.txt");
    await writeFile(sourcePath, "atomic");
    await commitLocalCoderArtifact({ sourcePath, hostArtifactPath, hostScratchRoot });
    await expect(
      verifyHostVisibleLocalCoderArtifact({
        hostArtifactPath,
        hostScratchRoot,
        expectedSourcePath: sourcePath,
      }),
    ).resolves.toBe(true);
  });

  it("rejects commits outside shared scratch", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-coder-"));
    tempRoots.push(root);
    await expect(
      commitLocalCoderArtifact({
        sourcePath: join(root, "source.txt"),
        hostArtifactPath: join(root, "outside.txt"),
        hostScratchRoot: join(root, "host"),
      }),
    ).rejects.toThrow(/escapes shared scratch/);
  });
});
