import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceInputPath, resolveWorkspaceOutputPath } from "./workspace-paths.js";

const cleanupDirs: string[] = [];

async function mkWorkspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("workspace-paths", () => {
  it("resolves valid in-workspace input files", async () => {
    const workspace = await mkWorkspace("openclaw-lp-ws-paths-");
    const filePath = path.join(workspace, "in", "source.pdf");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "pdf");

    const resolved = await resolveWorkspaceInputPath(workspace, filePath, "source_pdf");
    expect(resolved).toBe(await fs.realpath(filePath));
  });

  it("rejects input paths that escape workspace", async () => {
    const workspace = await mkWorkspace("openclaw-lp-ws-paths-");
    const outsideRoot = await mkWorkspace("openclaw-lp-ws-outside-");
    const outside = path.join(outsideRoot, "outside.pdf");
    await fs.writeFile(outside, "pdf");

    await expect(resolveWorkspaceInputPath(workspace, outside, "source_pdf")).rejects.toThrow(
      /within workspace/i,
    );
  });

  it("rejects output paths with ancestor symlink outside workspace", async () => {
    const workspace = await mkWorkspace("openclaw-lp-ws-paths-");
    const outsideRoot = await mkWorkspace("openclaw-lp-ws-outside-");
    const outsideDir = path.join(outsideRoot, "escape");
    await fs.mkdir(outsideDir, { recursive: true });
    const linkDir = path.join(workspace, "out-link");
    await fs.symlink(outsideDir, linkDir);

    await expect(
      resolveWorkspaceOutputPath(workspace, path.join(linkDir, "result.docx"), "output_path"),
    ).rejects.toThrow(/within workspace/i);
  });

  it("rejects output path when target is symlink to outside file", async () => {
    const workspace = await mkWorkspace("openclaw-lp-ws-paths-");
    const outsideRoot = await mkWorkspace("openclaw-lp-ws-outside-");
    const outsideFile = path.join(outsideRoot, "outside.docx");
    await fs.writeFile(outsideFile, "x");
    const linkFile = path.join(workspace, "out.docx");
    await fs.symlink(outsideFile, linkFile);

    await expect(resolveWorkspaceOutputPath(workspace, linkFile, "output_path")).rejects.toThrow(
      /within workspace/i,
    );
  });
});
