import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runExec = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec,
}));

describe("browser trash", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runExec.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
  });

  it("moves paths to the user trash without invoking a PATH-resolved command", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(runExec).not.toHaveBeenCalled();
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", { recursive: true });
    expect(existsSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123");
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("adds a secure suffix when the first trash destination already exists", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValueOnce(true).mockReturnValue(false);
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);

    await expect(movePathToTrash("/tmp/demo")).resolves.toMatch(
      /^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/,
    );
    expect(runExec).not.toHaveBeenCalled();
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", { recursive: true });
    expect(existsSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenCalledWith(
      "/tmp/demo",
      expect.stringMatching(/^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/),
    );
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("falls back to copy and remove when rename crosses filesystems", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi.spyOn(fs, "cpSync").mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(cpSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123", {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledWith("/tmp/demo", { recursive: true, force: true });
  });

  it("retries copy fallback when the copy destination is created concurrently", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const copyCollision = Object.assign(new Error("copy exists"), {
      code: "ERR_FS_CP_EEXIST",
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi
      .spyOn(fs, "cpSync")
      .mockImplementationOnce(() => {
        throw copyCollision;
      })
      .mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    await expect(movePathToTrash("/tmp/demo")).resolves.toMatch(
      /^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/,
    );
    expect(cpSync).toHaveBeenNthCalledWith(1, "/tmp/demo", "/home/test/.Trash/demo-123", {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(cpSync).toHaveBeenNthCalledWith(
      2,
      "/tmp/demo",
      expect.stringMatching(/^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/),
      {
        recursive: true,
        force: false,
        errorOnExist: true,
      },
    );
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("retries with the same timestamp when the destination is created concurrently", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const renameSync = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw collision;
      })
      .mockImplementation(() => undefined);

    await expect(movePathToTrash("/tmp/demo")).resolves.toMatch(
      /^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/,
    );
    expect(renameSync).toHaveBeenNthCalledWith(1, "/tmp/demo", "/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenNthCalledWith(
      2,
      "/tmp/demo",
      expect.stringMatching(/^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/),
    );
    expect(Date.now).toHaveBeenCalledTimes(1);
  });
});
