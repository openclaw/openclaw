// File Transfer tests cover canonical process-wrapper failures through dir fetch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandBufferedMock } = vi.hoisted(() => ({ runCommandBufferedMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandBufferedMock,
}));

import { handleDirFetch } from "./dir-fetch.js";

let tmpRoot: string;

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-errors-")));
  await fs.writeFile(path.join(tmpRoot, "ok.txt"), "ok");
});

afterEach(async () => {
  runCommandBufferedMock.mockReset();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("dir.fetch process wrapper", () => {
  it("falls back to capped tar when the optional du probe fails", async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: tmpRoot, gzip: true, portable: true }, ["ok.txt"])) {
      chunks.push(Buffer.from(chunk));
    }
    runCommandBufferedMock
      .mockRejectedValueOnce(new Error("du failed"))
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.concat(chunks) }));

    await expect(handleDirFetch({ path: tmpRoot, maxBytes: 1024 })).resolves.toMatchObject({
      ok: true,
      entries: ["ok.txt"],
    });
    expect(runCommandBufferedMock).toHaveBeenNthCalledWith(
      1,
      ["du", "-sk", tmpRoot],
      expect.objectContaining({ discardOutput: { stderr: true } }),
    );
  });

  it("rejects preflight-only requests once filesystem listing crosses the entry cap", async () => {
    await Promise.all(
      Array.from({ length: 5001 }, (_, index) =>
        fs.writeFile(path.join(tmpRoot, `file-${index}.txt`), ""),
      ),
    );

    await expect(
      handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "TREE_TOO_LARGE",
      message: "directory tree exceeds 5000 entries during preflight",
    });
    expect(runCommandBufferedMock).not.toHaveBeenCalled();
  });

  it("reclassifies a removed directory during preflight", async () => {
    runCommandBufferedMock.mockImplementationOnce(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      return commandResult({ code: 1 });
    });

    await expect(
      handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      message: expect.stringContaining("stat failed:"),
      canonicalPath: tmpRoot,
    });
    expect(runCommandBufferedMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid producer archive bytes before returning a transfer", async () => {
    runCommandBufferedMock
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.from("1\tproject\n") }))
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.from("archive") }));

    await expect(handleDirFetch({ path: tmpRoot, maxBytes: 1024 })).resolves.toMatchObject({
      ok: false,
      code: "READ_ERROR",
      message: expect.stringContaining("archive inspection failed:"),
    });
    expect(runCommandBufferedMock).toHaveBeenCalledTimes(2);
  });

  describe.each([true, false])("archive failures with preflight=%s", (preflightOnly) => {
    it.each(
      [
        {
          label: "output cap",
          result: commandResult({
            code: null,
            termination: "output-limit",
            outputLimitStream: "stdout",
          }),
          code: "TREE_TOO_LARGE",
          message: `tarball exceeded 1024 byte limit ${preflightOnly ? "during preflight" : "mid-stream"}`,
        },
        {
          label: "timeout",
          result: commandResult({ code: null, termination: "timeout" }),
          code: "READ_ERROR",
          message: "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
        },
        {
          label: "changed canonical path",
          result: commandResult({ code: 78 }),
          code: "CANONICAL_PATH_CHANGED",
          message: "canonical path differs from the authorized target",
        },
        {
          label: "launch error",
          result: new Error("spawn failed"),
          code: "READ_ERROR",
          message: "tar command failed",
        },
      ].filter(({ label }) =>
        preflightOnly ? label === "launch error" : label !== "launch error",
      ),
    )("classifies $label failures through handleDirFetch", async ({ result, code, message }) => {
      if (!preflightOnly) {
        runCommandBufferedMock.mockResolvedValueOnce(
          commandResult({ stdout: Buffer.from("1\tproject\n") }),
        );
      }
      if (result instanceof Error) {
        runCommandBufferedMock.mockRejectedValueOnce(result);
      } else {
        runCommandBufferedMock.mockResolvedValueOnce(result);
      }

      await expect(
        handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly }),
      ).resolves.toEqual({
        ok: false,
        code,
        message,
        canonicalPath: tmpRoot,
      });
      expect(runCommandBufferedMock).toHaveBeenCalledTimes(preflightOnly ? 1 : 2);
    });
  });
});
