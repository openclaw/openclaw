import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createEditTool } from "./edit.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function fixture(remote?: string) {
  const cwd = tempDirs.make("file-paths-");
  const file = (name: string) => path.join(cwd, name);
  const mapped = (absolute: string) => path.join(remote ?? cwd, path.relative(cwd, absolute));
  const operations = remote
    ? {
        access: (absolute: string) => fs.access(mapped(absolute)),
        readFile: (absolute: string) => fs.readFile(mapped(absolute)),
        writeFile: (absolute: string, text: string) => fs.writeFile(mapped(absolute), text, "utf8"),
        mkdir: async (absolute: string) => {
          await fs.mkdir(mapped(absolute), { recursive: true });
        },
        statFile: async (absolute: string) => {
          const stat = await fs.stat(mapped(absolute));
          const type = stat.isDirectory() ? "directory" : "file";
          return { type, size: stat.size, mtimeMs: stat.mtimeMs } as const;
        },
      }
    : undefined;
  const read = createReadTool(cwd, operations && { operations });
  const write = createWriteTool(cwd, operations && { operations });
  const edit = createEditTool(cwd, operations && { operations });
  const edits = [{ oldText: "written", newText: "edited" }];
  return {
    file,
    expectFile: (name: string, content: string) => expectFile(file(name), content),
    read: async (name: string) => (await read.execute("read", { path: name })).content,
    write: async (name: string, content: string) =>
      (await write.execute("write", { path: name, content })).details,
    edit: async (name: string) => (await edit.execute("edit", { path: name, edits })).details,
    list: async (name: string) => (await createLsTool(cwd).execute("ls", { path: name })).content,
  };
}
const text = (value: string) => [{ type: "text", text: value }];
const expectFile = (file: string, content: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(content);

it("preserves literal @ paths and shorthand across file operations", async () => {
  const f = fixture();
  for (const [name, content] of [
    ["@a.txt", "before\n"],
    ["a.txt", "sibling\n"],
    ["shorthand.txt", "short\n"],
  ] as const) {
    await fs.writeFile(f.file(name), content);
  }
  expect(await f.read("@shorthand.txt")).toEqual(text("short\n"));
  expect(await f.read("@a.txt")).toEqual(text("before\n"));
  expect(await f.write("@a.txt", "written\n")).toMatchObject({ changed: true, created: false });
  expect(await f.edit("@a.txt")).toMatchObject({ changed: true });
  await f.expectFile("@a.txt", "edited\n");
  await f.expectFile("a.txt", "sibling\n");
  await fs.mkdir(f.file("@dir"));
  expect(await f.write("@dir/new.txt", "child\n")).toMatchObject({ changed: true, created: true });
  expect(await f.list("@dir")).toEqual(text('"new.txt"'));
  await f.expectFile("@dir/new.txt", "child\n");
  await expect(fs.stat(f.file("dir"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps injected paths independent of colliding local @ files", async () => {
  const remote = tempDirs.make("file-paths-remote-");
  const f = fixture(remote);
  const target = path.join(remote, "target.txt");
  await fs.writeFile(f.file("@target.txt"), "local\n");
  await fs.writeFile(target, "before\n");
  expect(await f.read("@target.txt")).toEqual(text("before\n"));
  await f.write("@target.txt", "written\n");
  await f.edit("@target.txt");
  await expectFile(target, "edited\n");
  await f.expectFile("@target.txt", "local\n");
  await expect(fs.stat(path.join(remote, "@target.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
