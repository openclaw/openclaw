import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { azLoginDeviceCodeWithOptions } from "./cli.js";

function createChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe("azLoginDeviceCodeWithOptions", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it("preserves UTF-8 characters split across output chunks", async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const login = azLoginDeviceCodeWithOptions({});
    const emoji = Buffer.from("😀");
    child.stdout?.write(emoji.subarray(0, 2));
    child.stdout?.write(emoji.subarray(2));
    child.stderr?.write(emoji.subarray(0, 1));
    child.stderr?.write(emoji.subarray(1));
    child.emit("close", 0);

    await expect(login).resolves.toBeUndefined();
    expect(stdoutWrite).toHaveBeenCalledWith("😀");
    expect(stderrWrite).toHaveBeenCalledWith("😀");
  });

  it.each(["stdout", "stderr"] as const)("rejects when %s becomes unreadable", async (stream) => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const login = azLoginDeviceCodeWithOptions({});
    const error = new Error(`${stream} failed`);
    child[stream]?.emit("error", error);
    child.emit("close", 0);

    await expect(login).rejects.toThrow(`${stream} failed`);
  });
});
