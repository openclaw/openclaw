import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("registered core read on Windows", () => {
  it.runIf(process.platform === "win32").each(["", "cygdrive/", "mnt/"])(
    "reads, writes, and edits %s drive aliases through workspace containment",
    async (prefix) => {
      const workspaceDir = tempDirs.make("openclaw-drive-workspace-");
      const outsideDir = tempDirs.make("openclaw-drive-outside-");
      const alias = (target: string) => {
        const drive = target[0]!.toLowerCase();
        return `/${prefix}${drive}/${target.slice(3).replaceAll("\\", "/")}`;
      };
      const targetPath = path.join(workspaceDir, "note.txt");
      const outsidePath = path.join(outsideDir, "note.txt");
      await fs.writeFile(targetPath, "original", "utf8");
      await fs.writeFile(outsidePath, "outside", "utf8");
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(
        createOpenClawCodingTools({
          workspaceDir,
          config: { tools: { fs: { workspaceOnly: true } } },
        }),
      );

      expect(
        getTextContent(await readTool.execute("drive-read", { path: alias(targetPath) })),
      ).toBe("original");
      await writeTool.execute("drive-write", { path: `@${alias(targetPath)}`, content: "written" });
      await editTool.execute("drive-edit", {
        path: alias(targetPath),
        edits: [{ oldText: "written", newText: "edited" }],
      });
      expect(await fs.readFile(targetPath, "utf8")).toBe("edited");
      for (const [tool, args] of [
        [readTool, {}],
        [writeTool, { content: "denied" }],
        [editTool, { edits: [{ oldText: "outside", newText: "denied" }] }],
      ] as const) {
        await expect(
          tool.execute("drive-outside", { ...args, path: alias(outsidePath) }),
        ).rejects.toThrow(/Path escapes sandbox root/);
      }
      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside");
    },
  );

  it.runIf(process.platform === "win32")(
    "reads text produced by Windows PowerShell Out-File",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-core-read-utf16-");
      execFileSync(
        getWindowsPowerShellExePath(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "@('first', 'second') | Out-File -LiteralPath 'utf16.txt'",
        ],
        { cwd: workspaceDir, timeout: 10_000, windowsHide: true },
      );
      const filePath = path.join(workspaceDir, "utf16.txt");
      const bytes = await fs.readFile(filePath);
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));

      const { readTool } = expectReadWriteEditTools(createOpenClawCodingTools({ workspaceDir }));
      const result = await readTool.execute("tool-utf16-read", { path: filePath });
      expect(getTextContent(result)).toBe("first\nsecond\n");
    },
  );

  it.runIf(process.platform === "win32")("reads a Windows-style home path", async () => {
    const homeDir = process.env.HOME ?? os.homedir();
    const homeTestDir = tempDirs.make("openclaw-core-read-home-", homeDir);
    const workspaceDir = tempDirs.make("openclaw-core-read-workspace-");
    const targetPath = path.join(homeTestDir, "same-path.txt");
    const modelPath = `~\\${path.relative(homeDir, targetPath)}`;
    await fs.writeFile(targetPath, "home read", "utf8");

    const { readTool } = expectReadWriteEditTools(createOpenClawCodingTools({ workspaceDir }));
    const result = await readTool.execute("tool-home-read", { path: modelPath });
    expect(getTextContent(result)).toContain("home read");
  });
});
