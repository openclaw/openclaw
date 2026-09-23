import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("registered core read on Windows", () => {
  it.runIf(process.platform === "win32")(
    "reads UTF-16LE BOM text with Windows line endings",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-core-read-utf16-");
      const filePath = path.join(workspaceDir, "utf16.txt");
      // Match the UTF-16LE BOM and CRLF output of Windows PowerShell 5.1 Out-File.
      await fs.writeFile(filePath, Buffer.from("\uFEFFfirst\r\nsecond\r\n", "utf16le"));
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

    const tools = createOpenClawCodingTools({ workspaceDir });
    const { readTool } = expectReadWriteEditTools(tools);
    const result = await readTool?.execute("tool-home-read", { path: modelPath });
    const text = result?.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    expect(text).toContain("home read");
  });
});
