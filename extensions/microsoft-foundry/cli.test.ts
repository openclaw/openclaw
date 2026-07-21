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
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn().mockReturnValue(true);
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = kill;
  return { child, stdout, stderr, kill };
}

describe("azLoginDeviceCodeWithOptions", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it("preserves UTF-8 characters split across output chunks", async () => {
    const { child, stdout, stderr } = createChild();
    spawnMock.mockReturnValue(child);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const login = azLoginDeviceCodeWithOptions({});
    const emoji = Buffer.from("😀");
    stdout.write(emoji.subarray(0, 2));
    stdout.write(emoji.subarray(2));
    stderr.write(emoji.subarray(0, 1));
    stderr.write(emoji.subarray(1));
    child.emit("close", 0);

    await expect(login).resolves.toBeUndefined();
    expect(stdoutWrite).toHaveBeenCalledWith("😀");
    expect(stderrWrite).toHaveBeenCalledWith("😀");
  });

  it.each(["stdout", "stderr"] as const)(
    "terminates the child when %s becomes unreadable",
    async (stream) => {
      const { child, kill } = createChild();
      spawnMock.mockReturnValue(child);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const login = azLoginDeviceCodeWithOptions({});
      const error = new Error(`${stream} failed`);
      child[stream]?.emit("error", error);

      await expect(login).rejects.toThrow(`${stream} failed`);
      expect(kill).toHaveBeenCalledOnce();
    },
  );

  it("terminates the child once when both output streams fail", async () => {
    const { child, stdout, stderr, kill } = createChild();
    spawnMock.mockReturnValue(child);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const login = azLoginDeviceCodeWithOptions({});
    const firstError = new Error("stdout failed");
    stdout.emit("error", firstError);
    stderr.emit("error", new Error("stderr failed"));
    child.emit("close", null);

    await expect(login).rejects.toBe(firstError);
    expect(kill).toHaveBeenCalledOnce();
  });
});
