import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReadPath } from "./path-utils.js";
import { normalizeWindowsPosixDrivePath } from "./windows-posix-path.js";

describe("normalizeWindowsPosixDrivePath", () => {
  it.each([
    ["/c/Users/Test/file.txt", "C:\\Users\\Test\\file.txt"],
    ["/cygdrive/d/work/file.txt", "D:\\work\\file.txt"],
    ["/mnt/e/work/file.txt", "E:\\work\\file.txt"],
    ["/f", "F:\\"],
  ])("maps %s to %s on native Windows", (input, expected) => {
    expect(normalizeWindowsPosixDrivePath(input, "win32")).toBe(expected);
  });

  it.each(["/home/user/file.txt", "/tmp/file.txt", "/mnt/home/file.txt", "//server/share"])(
    "leaves non-drive path %s unchanged",
    (input) => {
      expect(normalizeWindowsPosixDrivePath(input, "win32")).toBe(input);
    },
  );

  it("leaves POSIX drive-like paths unchanged outside Windows", () => {
    expect(normalizeWindowsPosixDrivePath("/c/work/file.txt", "linux")).toBe("/c/work/file.txt");
  });
});

describe.runIf(process.platform === "win32")("resolveReadPath Windows POSIX drive paths", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("resolves a Git Bash path to an existing native file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-msys-read-"));
    tempDirs.push(dir);
    const nativePath = join(dir, "fixture.txt");
    await writeFile(nativePath, "fixture", "utf8");
    const gitBashPath = `/${nativePath[0]?.toLowerCase()}${nativePath.slice(2).replaceAll("\\", "/")}`;

    expect(resolveReadPath(gitBashPath, dir)).toBe(nativePath);
  });
});
