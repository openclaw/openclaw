import fs from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";

const { runCommandBufferedMock } = vi.hoisted(() => ({ runCommandBufferedMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandBufferedMock,
}));

import { handleDirFetch } from "./dir-fetch.js";
import { useFiles } from "./node-host.test-support.js";

const { at, file } = useFiles("dir-fetch-errors-", () => runCommandBufferedMock.mockReset());

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

beforeEach(() => file("ok.txt", "ok"));

const fetchDirectory = (preflightOnly = false) =>
  handleDirFetch({ path: at(), maxBytes: 1024, preflightOnly });

async function expectFailure(code: string, message: unknown, preflightOnly = false) {
  await expect(fetchDirectory(preflightOnly)).resolves.toEqual({
    ok: false,
    code,
    message,
    canonicalPath: at(),
  });
  expect(runCommandBufferedMock).toHaveBeenCalledTimes(1);
}

it("rejects preflight-only requests once filesystem listing crosses the entry cap", async () => {
  await Promise.all(
    Array.from({ length: 5001 }, (_, index) => fs.writeFile(at(`file-${index}.txt`), "")),
  );

  await expect(fetchDirectory(true)).resolves.toMatchObject({
    ok: false,
    code: "TREE_TOO_LARGE",
    message: "directory tree exceeds 5000 entries during preflight",
  });
  expect(runCommandBufferedMock).not.toHaveBeenCalled();
});

it("reclassifies a removed directory during preflight", async () => {
  runCommandBufferedMock.mockImplementationOnce(async () => {
    await fs.rm(at(), { recursive: true, force: true });
    return commandResult({ code: 1 });
  });

  await expectFailure("NOT_FOUND", expect.stringContaining("stat failed:"), true);
});

it("rejects invalid producer archive bytes before returning a transfer", async () => {
  runCommandBufferedMock.mockResolvedValueOnce(commandResult({ stdout: Buffer.from("archive") }));

  await expectFailure("READ_ERROR", expect.stringContaining("archive inspection failed:"));
});

it.each([
  [
    "output cap",
    { code: null, termination: "output-limit", outputLimitStream: "stdout" },
    "TREE_TOO_LARGE",
    "tarball exceeded 1024 byte limit mid-stream",
  ],
  [
    "timeout",
    { code: null, termination: "timeout" },
    "READ_ERROR",
    "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
  ],
  [
    "changed canonical path",
    { code: 78 },
    "CANONICAL_PATH_CHANGED",
    "resolved path differs from the authorized target",
  ],
  ["launch error", new Error("spawn failed"), "READ_ERROR", "tar command failed"],
] as const)(
  "classifies %s failures through handleDirFetch",
  async (label, result, code, message) => {
    if (result instanceof Error) {
      runCommandBufferedMock.mockRejectedValueOnce(result);
    } else {
      runCommandBufferedMock.mockResolvedValueOnce(commandResult(result));
    }

    await expectFailure(code, message, label === "launch error");
  },
);
