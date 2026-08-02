import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool, type EditOperations } from "./edit.js";
import { resolveReadPath } from "./path-utils.js";
import { normalizeWindowsPosixDrivePath } from "./windows-posix-path.js";
import { createWriteTool, type WriteOperations } from "./write.js";

function toWindowsPosixDrivePath(nativePath: string, prefix: "" | "cygdrive/" | "mnt/"): string {
  const drive = nativePath[0]?.toLowerCase();
  if (!drive || nativePath[1] !== ":") {
    throw new Error(`Expected a Windows drive path, got ${nativePath}`);
  }
  return `/${prefix}${drive}${nativePath.slice(2).replaceAll("\\", "/")}`;
}

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

describe.runIf(process.platform === "win32")("local Windows POSIX drive paths", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each(["", "cygdrive/", "mnt/"] as const)(
    "reads an existing file through the %s form",
    async (prefix) => {
      const dir = await mkdtemp(join(tmpdir(), "openclaw-msys-read-"));
      tempDirs.push(dir);
      const nativePath = join(dir, "fixture.txt");
      await writeFile(nativePath, "fixture", "utf8");

      expect(resolveReadPath(toWindowsPosixDrivePath(nativePath, prefix), dir)).toBe(nativePath);
    },
  );

  it.each(["", "cygdrive/", "mnt/"] as const)("writes through the %s form", async (prefix) => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-msys-read-"));
    tempDirs.push(dir);
    const nativePath = join(dir, "written.txt");
    const tool = createWriteTool(dir);

    await tool.execute("write-posix-drive", {
      path: toWindowsPosixDrivePath(nativePath, prefix),
      content: "written",
    });

    await expect(readFile(nativePath, "utf8")).resolves.toBe("written");
  });

  it.each(["", "cygdrive/", "mnt/"] as const)("edits through the %s form", async (prefix) => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-msys-edit-"));
    tempDirs.push(dir);
    const nativePath = join(dir, "edited.txt");
    await writeFile(nativePath, "before", "utf8");
    const tool = createEditTool(dir);

    await tool.execute("edit-posix-drive", {
      path: toWindowsPosixDrivePath(nativePath, prefix),
      edits: [{ oldText: "before", newText: "after" }],
    });

    await expect(readFile(nativePath, "utf8")).resolves.toBe("after");
  });
});

describe("injected path resolver ownership", () => {
  const remotePaths = [
    "/c/work/file.txt",
    "/cygdrive/c/work/file.txt",
    "/mnt/c/work/file.txt",
    "/home/user/file.txt",
    "/tmp/file.txt",
    "//server/share/file.txt",
  ];

  it.each(remotePaths)("leaves remote write path %s unchanged", async (remotePath) => {
    let persisted: Buffer | undefined;
    const remoteWriteFile = vi.fn<WriteOperations["writeFile"]>(async (_path, content) => {
      persisted = Buffer.from(content, "utf8");
    });
    const operations: WriteOperations = {
      resolvePath: (filePath) => filePath,
      mkdir: async () => {},
      writeFile: remoteWriteFile,
      readFile: async () => {
        if (!persisted) {
          throw new Error("No such file or directory");
        }
        return persisted;
      },
      statFile: async () => (persisted ? { type: "file", size: persisted.byteLength } : null),
    };
    const tool = createWriteTool("/remote/workspace", { operations });

    await tool.execute("remote-write", { path: remotePath, content: "content" });

    expect(remoteWriteFile).toHaveBeenCalledWith(remotePath, "content");
  });

  it.each(remotePaths)("leaves remote edit path %s unchanged", async (remotePath) => {
    let persisted = Buffer.from("before");
    const remoteReadFile = vi.fn<EditOperations["readFile"]>(async () => persisted);
    const remoteWriteFile = vi.fn<EditOperations["writeFile"]>(async (_path, content) => {
      persisted = Buffer.from(content, "utf8");
    });
    const access = vi.fn<EditOperations["access"]>();
    const operations: EditOperations = {
      resolvePath: (filePath) => filePath,
      access,
      readFile: remoteReadFile,
      statFile: async () => ({ type: "file", size: persisted.byteLength }),
      writeFile: remoteWriteFile,
    };
    const tool = createEditTool("/remote/workspace", { operations });

    await tool.execute("remote-edit", {
      path: remotePath,
      edits: [{ oldText: "before", newText: "after" }],
    });

    expect(access).toHaveBeenCalledWith(remotePath);
    expect(remoteReadFile).toHaveBeenCalledWith(remotePath);
    expect(remoteWriteFile).toHaveBeenCalledWith(remotePath, "after");
  });
});
