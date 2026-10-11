import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createEditTool } from "./edit.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session file tool path ownership", () => {
  it("preserves literal @ paths across session file operations and keeps shorthand", async () => {
    const cwd = tempDirs.make("openclaw-tool-factories-at-paths-");
    const tools = {
      read: createReadTool(cwd),
      write: createWriteTool(cwd),
      edit: createEditTool(cwd),
      ls: createLsTool(cwd),
    };
    await fs.writeFile(path.join(cwd, "@literal.txt"), "literal before\n");
    await fs.writeFile(path.join(cwd, "literal.txt"), "plain sibling\n");
    await fs.writeFile(path.join(cwd, "shorthand.txt"), "shorthand control\n");

    const shorthand = await tools.read.execute("read-shorthand", { path: "@shorthand.txt" });
    expect(shorthand.content).toEqual([{ type: "text", text: "shorthand control\n" }]);
    const literal = await tools.read.execute("read-literal", { path: "@literal.txt" });
    expect(literal.content).toEqual([{ type: "text", text: "literal before\n" }]);

    const written = await tools.write.execute("write-literal", {
      path: "@literal.txt",
      content: "literal written\n",
    });
    expect(written.details).toMatchObject({ changed: true, created: false });
    const edited = await tools.edit.execute("edit-literal", {
      path: "@literal.txt",
      edits: [{ oldText: "written", newText: "edited" }],
    });
    expect(edited.details).toMatchObject({ changed: true });
    await expect(fs.readFile(path.join(cwd, "@literal.txt"), "utf8")).resolves.toBe(
      "literal edited\n",
    );
    await expect(fs.readFile(path.join(cwd, "literal.txt"), "utf8")).resolves.toBe(
      "plain sibling\n",
    );

    await fs.mkdir(path.join(cwd, "@directory"));
    const created = await tools.write.execute("write-literal-child", {
      path: "@directory/new.txt",
      content: "literal child\n",
    });
    expect(created.details).toMatchObject({ changed: true, created: true });
    const listed = await tools.ls.execute("list-literal-directory", { path: "@directory" });
    expect(listed.content).toEqual([{ type: "text", text: '"new.txt"' }]);
    await expect(fs.readFile(path.join(cwd, "@directory/new.txt"), "utf8")).resolves.toBe(
      "literal child\n",
    );
    await expect(fs.stat(path.join(cwd, "directory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps injected file paths independent of colliding local @ files", async () => {
    const cwd = tempDirs.make("openclaw-tool-factories-local-");
    const remote = tempDirs.make("openclaw-tool-factories-remote-");
    await fs.writeFile(path.join(cwd, "@target.txt"), "local sentinel\n");
    await fs.writeFile(path.join(remote, "target.txt"), "remote before\n");
    const remotePath = (absolutePath: string) =>
      path.join(remote, path.relative(cwd, absolutePath));
    const access = (absolutePath: string) => fs.access(remotePath(absolutePath));
    const readFile = (absolutePath: string) => fs.readFile(remotePath(absolutePath));
    const writeFile = (absolutePath: string, content: string) =>
      fs.writeFile(remotePath(absolutePath), content, "utf8");
    const statFile = async (absolutePath: string) => {
      const stat = await fs.stat(remotePath(absolutePath));
      return {
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } as const;
    };
    const tools = {
      read: createReadTool(cwd, { operations: { access, readFile } }),
      write: createWriteTool(cwd, {
        operations: {
          readFile,
          writeFile,
          statFile,
          mkdir: async (directory) => {
            await fs.mkdir(remotePath(directory), { recursive: true });
          },
        },
      }),
      edit: createEditTool(cwd, { operations: { access, readFile, writeFile, statFile } }),
    };

    const read = await tools.read.execute("read-remote", { path: "@target.txt" });
    expect(read.content).toEqual([{ type: "text", text: "remote before\n" }]);
    await tools.write.execute("write-remote", { path: "@target.txt", content: "remote written\n" });
    await tools.edit.execute("edit-remote", {
      path: "@target.txt",
      edits: [{ oldText: "written", newText: "edited" }],
    });
    await expect(fs.readFile(path.join(remote, "target.txt"), "utf8")).resolves.toBe(
      "remote edited\n",
    );
    await expect(fs.readFile(path.join(cwd, "@target.txt"), "utf8")).resolves.toBe(
      "local sentinel\n",
    );
    await expect(fs.stat(path.join(remote, "@target.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
