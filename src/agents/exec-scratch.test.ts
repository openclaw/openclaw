import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import * as fsSafe from "@openclaw/fs-safe/root";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareAgentExecScratch } from "./exec-scratch.js";

vi.mock("@openclaw/fs-safe/root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/root")>();
  return { ...actual, root: vi.fn(actual.root) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let workspace: string;
let fallback: string;

beforeEach(() => {
  workspace = tempDirs.make("exec-scratch-workspace-");
  fallback = path.join(tempDirs.make("exec-scratch-private-"), "tmp");
  vi.stubEnv("OPENCLAW_INTERNAL_WORKER_TMPDIR", fallback);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps writable workspace scratch on the workspace filesystem", async () => {
  const scratch = path.join(await fs.realpath(workspace), ".openclaw", "tmp");
  await expect(prepareAgentExecScratch(workspace)).resolves.toEqual({
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  });
  await fs.writeFile(path.join(scratch, "result"), "writable");
  await expect(fs.stat(fallback)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "uses private scratch without changing an unwritable workspace",
  async () => {
    await fs.chmod(workspace, 0o555);
    try {
      const env = await prepareAgentExecScratch(workspace);
      const privateRoot = await fs.realpath(fallback);
      expect(env).toEqual({ TMPDIR: privateRoot, TMP: privateRoot, TEMP: privateRoot });
      const stat = await fs.stat(env.TMPDIR);
      expect(stat.uid).toBe(process.getuid?.());
      expect(stat.mode & 0o777).toBe(0o700);
      await fs.writeFile(path.join(env.TMPDIR, "result"), "writable");
      expect(await fs.readdir(workspace)).toEqual([]);
      expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    } finally {
      await fs.chmod(workspace, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32")("preserves workspace symlink rejection", async () => {
  const outside = tempDirs.make("exec-scratch-outside-");
  await fs.symlink(outside, path.join(workspace, ".openclaw"), "dir");
  await expect(prepareAgentExecScratch(workspace)).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
  await expect(fs.stat(fallback)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves root identity failures with a permission cause", async () => {
  const opened = await fsSafe.root(workspace);
  const error = new FsSafeError("path-mismatch", "root identity changed", {
    cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
  });
  vi.spyOn(opened, "mkdir").mockRejectedValue(error);
  vi.mocked(fsSafe.root).mockResolvedValueOnce(opened);
  await expect(prepareAgentExecScratch(workspace)).rejects.toBe(error);
  await expect(fs.stat(fallback)).rejects.toMatchObject({ code: "ENOENT" });
});
