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

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(runExec).not.toHaveBeenCalled();
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", { recursive: true });
    expect(existsSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123");
  });

  it("adds a secure suffix when the first trash destination already exists", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(true);
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
  });
});
