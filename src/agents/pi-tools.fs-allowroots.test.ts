import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return { ...mod, getShellPathFromLoginShell: () => null };
});

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function getTextContent(result?: { content?: Array<{ type: string; text?: string }> }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

describe("tools.fs.allowRoots", () => {
  it("allows absolute paths inside allowRoots when workspaceOnly is enabled", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-allow-", async (allowRoot) => {
        const cfg = {
          tools: {
            fs: { workspaceOnly: true, allowRoots: [allowRoot] },
            exec: { applyPatch: { enabled: true } },
          },
        } as unknown as OpenClawConfig;

        const tools = createOpenClawCodingTools({
          workspaceDir,
          config: cfg,
          modelProvider: "openai",
          modelId: "gpt-5.2",
        });
        const readTool = tools.find((tool) => tool.name === "read");
        const writeTool = tools.find((tool) => tool.name === "write");
        const editTool = tools.find((tool) => tool.name === "edit");
        const applyPatchTool = tools.find((tool) => tool.name === "apply_patch");
        expect(readTool).toBeDefined();
        expect(writeTool).toBeDefined();
        expect(editTool).toBeDefined();
        expect(applyPatchTool).toBeDefined();

        const allowedFile = path.join(allowRoot, "allowed.txt");
        await writeTool?.execute("t-allow-write", {
          path: allowedFile,
          content: "allow write ok",
        });
        expect(await fs.readFile(allowedFile, "utf8")).toBe("allow write ok");

        const editFile = path.join(allowRoot, "edit.txt");
        await fs.writeFile(editFile, "hello world", "utf8");
        await editTool?.execute("t-allow-edit", {
          path: editFile,
          oldText: "world",
          newText: "openclaw",
        });
        expect(await fs.readFile(editFile, "utf8")).toBe("hello openclaw");

        const readResult = await readTool?.execute("t-allow-read", { path: editFile });
        expect(getTextContent(readResult)).toContain("hello openclaw");

        const patchFile = path.join(allowRoot, "patch.txt");
        const patch = `*** Begin Patch
*** Add File: ${patchFile}
+patched
*** End Patch`;
        await applyPatchTool?.execute("t-allow-apply", { input: patch });
        expect(await fs.readFile(patchFile, "utf8")).toBe("patched\n");
      });
    });
  });

  it("rejects paths outside workspace and allowRoots when workspaceOnly is enabled", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-allow-", async (allowRoot) => {
        await withTempDir("openclaw-outside-", async (outsideRoot) => {
          const cfg = {
            tools: {
              fs: { workspaceOnly: true, allowRoots: [allowRoot] },
            },
          } as unknown as OpenClawConfig;

          const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
          const writeTool = tools.find((tool) => tool.name === "write");
          expect(writeTool).toBeDefined();

          const outsideFile = path.join(outsideRoot, "nope.txt");
          await expect(
            writeTool?.execute("t-outside-write", {
              path: outsideFile,
              content: "nope",
            }),
          ).rejects.toThrow(/allowed roots/i);
          await expect(fs.stat(outsideFile)).rejects.toMatchObject({ code: "ENOENT" });
        });
      });
    });
  });
});
