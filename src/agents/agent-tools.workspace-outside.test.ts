import fs from "node:fs/promises";
import path from "node:path";
import { createReadTool } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  wrapToolMemoryFlushAppendOnlyWrite,
} from "./agent-tools.read.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaceOnly = { tools: { fs: { workspaceOnly: true } } };
const guardedRead = (workspaceDir: string) =>
  expectReadWriteEditTools(createOpenClawCodingTools({ workspaceDir, config: workspaceOnly }))
    .readTool;

describe("memory filesystem policy", () => {
  let workspaceDir: string;

  const memoryWriteTool = (relativePath: string) =>
    wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(workspaceDir), {
      root: workspaceDir,
      relativePath,
    });

  beforeEach(async () => {
    workspaceDir = path.join(tempDirs.make("openclaw-workspace-outside-"), "workspace");
    await fs.mkdir(workspaceDir);
  });

  it("makes only missing canonical daily-memory reads implicitly optional", async () => {
    const read = createOpenClawReadTool(createReadTool(workspaceDir));
    const readPath = (file: string) => read.execute("read", { path: file });
    for (const filePath of [
      ...["", "./", "././"].map((prefix) => `${prefix}memory/2026-05-15.md`),
      ...(process.platform === "win32" ? ["memory\\2026-05-19.md"] : []),
    ]) {
      expect(await readPath(filePath)).toStrictEqual({
        content: [{ type: "text", text: `Optional file not found: ${filePath}.` }],
        details: { kind: "not_found", status: "not_found", path: filePath, optional: true },
      });
    }
    const existingPath = "memory/2026-05-17.md";
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, existingPath), "present daily memory");
    expect(getTextContent(await readPath(existingPath))).toBe("present daily memory");
    for (const filePath of [
      "notes/missing.md",
      "memory/2026-05-15-session.md",
      "../memory/2026-05-15.md",
      " memory/2026-05-15.md",
      "memory/2026-05-15.md ",
      ...(process.platform === "win32" ? [] : ["memory\\2026-05-15.md"]),
    ]) {
      await expect(readPath(filePath)).rejects.toThrow(/ENOENT|no such file|not found/i);
    }
  });

  it.each([true, false])(
    "validates memory append paths after suffix stripping (valid: %s)",
    async (valid) => {
      const file = "memory/2026-03-08.md";
      const result = memoryWriteTool(file).execute("write", {
        path: `${valid ? file : ""}</arg_value>>`,
        content: "new note",
      });
      if (!valid) {
        await expect(result).rejects.toThrow(/Missing required parameter: path/);
        return;
      }
      expect(await result).toStrictEqual({
        content: [{ type: "text", text: "Appended content to memory/2026-03-08.md." }],
        details: { changed: true },
      });
      await expect(fs.readFile(path.join(workspaceDir, file), "utf-8")).resolves.toBe("new note");
    },
  );
});

it("does not follow a filename fallback into a sibling workspace", async (context) => {
  const rootDir = tempDirs.make("openclaw-unicode-parent-");
  const workspaceDir = path.join(rootDir, "cafe\u0301");
  const outsideDir = path.join(rootDir, "caf\u00e9");
  await fs.mkdir(workspaceDir);
  try {
    await fs.mkdir(outsideDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    context.skip();
    return;
  }
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside secret", "utf8");

  await expect(guardedRead(workspaceDir).execute("read", { path: "secret.txt" })).rejects.toThrow(
    /File not found/i,
  );
});

it("keeps filename fallback working inside the guarded workspace", async () => {
  const workspaceDir = tempDirs.make("openclaw-unicode-leaf-");
  await fs.writeFile(path.join(workspaceDir, "d\u2019accord.txt"), "allowed fallback", "utf8");

  const result = await guardedRead(workspaceDir).execute("read", { path: "d'accord.txt" });
  expect(getTextContent(result)).toContain("allowed fallback");
});
