import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "../shared/node-invoke-policy.js";
import { createCtx } from "../shared/node-invoke-policy.test-support.js";
import { handleFileStat } from "./file-stat.js";

vi.mock("../shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

let directory: string;
let file: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(async () => {
  directory = await fs.realpath(tempDirs.make("file-stat-test-"));
  file = path.join(directory, "AGENTS.md");
  await fs.writeFile(file, "workspace instructions");
});

describe("file.stat", () => {
  it.each(["file", "directory"] as const)(
    "reads %s metadata without fetching content",
    async (type) => {
      const target = type === "file" ? file : directory;
      const stats = await fs.stat(target, { bigint: true });
      const result = await handleFileStat({ path: target });
      expect(result).toMatchObject({
        ok: true,
        path: target,
        type,
        size: Number(stats.size),
        mtimeMs: Number(stats.mtimeNs) / 1_000_000,
        binding: { kind: "existing", device: String(stats.dev), inode: String(stats.ino) },
      });
      expect(result).not.toHaveProperty("base64");
    },
  );

  it("distinguishes missing paths from invalid input", async () => {
    expect(await handleFileStat({ path: path.join(directory, "missing") })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await handleFileStat({ path: "AGENTS.md" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects symlinks by default and returns the canonical target when allowed", async () => {
    const link = path.join(directory, "link");
    await fs.symlink(file, link);
    expect(await handleFileStat({ path: link })).toMatchObject({
      ok: false,
      code: "SYMLINK_REDIRECT",
    });
    expect(await handleFileStat({ path: link, followSymlinks: true })).toMatchObject({
      ok: true,
      path: file,
    });
    expect(
      await handleFileStat({ path: link, followSymlinks: true, expectedCanonicalPath: link }),
    ).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
  });

  it("refuses a replacement at the same path after authorization", async () => {
    const authorized = await handleFileStat({ path: file, preflightOnly: true });
    if (!authorized.ok) {
      throw new Error(authorized.message);
    }
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, "replacement");
    expect(
      await handleFileStat({
        path: file,
        expectedCanonicalPath: authorized.path,
        expectedBinding: authorized.binding,
      }),
    ).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
  });

  it("uses the existing read grant and does not require access to the parent directory", async () => {
    const { ctx, invokeNode } = createCtx({
      command: "file.stat",
      params: { path: file, followSymlinks: true, preflightOnly: true },
      pluginConfig: { nodes: { "node-1": { allowReadPaths: [file], ask: "off" } } },
    });
    invokeNode.mockImplementation(async ({ params } = {}) => ({
      ok: true,
      payload: await handleFileStat(params as Parameters<typeof handleFileStat>[0]),
    }));
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
      ok: true,
      payload: { ok: true, path: file, type: "file" },
    });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(invokeNode.mock.calls[1]?.[0]?.params).toMatchObject({
      path: file,
      followSymlinks: false,
      expectedCanonicalPath: file,
      expectedBinding: { kind: "existing" },
    });
    invokeNode.mockClear();
    expect(
      await createFileTransferNodeInvokePolicy().handle({ ...ctx, params: { path: directory } }),
    ).toMatchObject({ ok: false });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});
