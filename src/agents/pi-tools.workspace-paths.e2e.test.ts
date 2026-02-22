import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/pi-tools-fs-helpers.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";

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

describe("workspace path resolution", () => {
  it("reads relative paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-cwd-", async (otherDir) => {
        const testFile = "read.txt";
        const contents = "workspace read ok";
        await fs.writeFile(path.join(workspaceDir, testFile), contents, "utf8");

        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherDir);
        try {
          const tools = createOpenClawCodingTools({ workspaceDir });
          const readTool = tools.find((tool) => tool.name === "read");
          expect(readTool).toBeDefined();

          const result = await readTool?.execute("ws-read", { path: testFile });
          expect(getTextContent(result)).toContain(contents);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  it("writes relative paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-cwd-", async (otherDir) => {
        const testFile = "write.txt";
        const contents = "workspace write ok";

        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherDir);
        try {
          const tools = createOpenClawCodingTools({ workspaceDir });
          const writeTool = tools.find((tool) => tool.name === "write");
          expect(writeTool).toBeDefined();

          await writeTool?.execute("ws-write", {
            path: testFile,
            content: contents,
          });

          const written = await fs.readFile(path.join(workspaceDir, testFile), "utf8");
          expect(written).toBe(contents);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  it("edits relative paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-cwd-", async (otherDir) => {
        const testFile = "edit.txt";
        await fs.writeFile(path.join(workspaceDir, testFile), "hello world", "utf8");

        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherDir);
        try {
          const tools = createOpenClawCodingTools({ workspaceDir });
          const editTool = tools.find((tool) => tool.name === "edit");
          expect(editTool).toBeDefined();

          await editTool?.execute("ws-edit", {
            path: testFile,
            oldText: "world",
            newText: "openclaw",
          });

          const updated = await fs.readFile(path.join(workspaceDir, testFile), "utf8");
          expect(updated).toBe("hello openclaw");
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  it("blocks reading absolute paths outside workspace in host mode by default", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-outside-", async (outsideDir) => {
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "nope", "utf8");

        const tools = createOpenClawCodingTools({ workspaceDir });
        const readTool = tools.find((tool) => tool.name === "read");
        expect(readTool).toBeDefined();

        await expect(readTool?.execute("ws-outside-read", { path: outsideFile })).rejects.toThrow(
          /Path escapes sandbox root/i,
        );
      });
    });
  });

  it.runIf(process.platform !== "win32")(
    "blocks reading /etc/passwd in host mode by default",
    async () => {
      await withTempDir("openclaw-ws-", async (workspaceDir) => {
        const tools = createOpenClawCodingTools({ workspaceDir });
        const readTool = tools.find((tool) => tool.name === "read");
        expect(readTool).toBeDefined();

        await expect(readTool?.execute("ws-etc-read", { path: "/etc/passwd" })).rejects.toThrow(
          /Path escapes sandbox root/i,
        );
      });
    },
  );

  it("blocks symlink escapes in host mode by default", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-outside-", async (outsideDir) => {
        const outsideFile = path.join(outsideDir, "secret.txt");
        const linkPath = path.join(workspaceDir, "linked-secret.txt");
        await fs.writeFile(outsideFile, "secret", "utf8");
        try {
          await fs.symlink(outsideFile, linkPath);
        } catch {
          return;
        }

        const tools = createOpenClawCodingTools({ workspaceDir });
        const readTool = tools.find((tool) => tool.name === "read");
        expect(readTool).toBeDefined();

        await expect(readTool?.execute("ws-link-read", { path: linkPath })).rejects.toThrow(
          /Symlink escapes sandbox root/i,
        );
      });
    });
  });

  it("allows host-mode paths outside workspace only with fs.allowOutsideWorkspace=true", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-outside-", async (outsideDir) => {
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "allowed", "utf8");

        const cfg = {
          tools: { fs: { allowOutsideWorkspace: true } },
        } as unknown as OpenClawConfig;
        const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
        const readTool = tools.find((tool) => tool.name === "read");
        expect(readTool).toBeDefined();

        const result = await readTool?.execute("ws-outside-read-allowed", { path: outsideFile });
        expect(getTextContent(result)).toContain("allowed");
      });
    });
  });

  it("defaults exec cwd to workspaceDir when workdir is omitted", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        exec: { host: "gateway", ask: "off", security: "full" },
      });
      const execTool = tools.find((tool) => tool.name === "exec");
      expect(execTool).toBeDefined();

      const result = await execTool?.execute("ws-exec", {
        command: "echo ok",
      });
      const cwd =
        result?.details && typeof result.details === "object" && "cwd" in result.details
          ? (result.details as { cwd?: string }).cwd
          : undefined;
      expect(cwd).toBeTruthy();
      const [resolvedOutput, resolvedWorkspace] = await Promise.all([
        fs.realpath(String(cwd)),
        fs.realpath(workspaceDir),
      ]);
      expect(resolvedOutput).toBe(resolvedWorkspace);
    });
  });

  it("lets exec workdir override the workspace default", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-override-", async (overrideDir) => {
        const tools = createOpenClawCodingTools({
          workspaceDir,
          exec: { host: "gateway", ask: "off", security: "full" },
        });
        const execTool = tools.find((tool) => tool.name === "exec");
        expect(execTool).toBeDefined();

        const result = await execTool?.execute("ws-exec-override", {
          command: "echo ok",
          workdir: overrideDir,
        });
        const cwd =
          result?.details && typeof result.details === "object" && "cwd" in result.details
            ? (result.details as { cwd?: string }).cwd
            : undefined;
        expect(cwd).toBeTruthy();
        const [resolvedOutput, resolvedOverride] = await Promise.all([
          fs.realpath(String(cwd)),
          fs.realpath(overrideDir),
        ]);
        expect(resolvedOutput).toBe(resolvedOverride);
      });
    });
  });
});

describe("sandboxed workspace paths", () => {
  it("uses sandbox workspace for relative read/write/edit", async () => {
    await withTempDir("openclaw-sandbox-", async (sandboxDir) => {
      await withTempDir("openclaw-workspace-", async (workspaceDir) => {
        const sandbox = createPiToolsSandboxContext({
          workspaceDir: sandboxDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw" as const,
          fsBridge: createHostSandboxFsBridge(sandboxDir),
          tools: { allow: [], deny: [] },
        });

        const testFile = "sandbox.txt";
        await fs.writeFile(path.join(sandboxDir, testFile), "sandbox read", "utf8");
        await fs.writeFile(path.join(workspaceDir, testFile), "workspace read", "utf8");

        const tools = createOpenClawCodingTools({ workspaceDir, sandbox });
        const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

        const result = await readTool?.execute("sbx-read", { path: testFile });
        expect(getTextContent(result)).toContain("sandbox read");

        await writeTool?.execute("sbx-write", {
          path: "new.txt",
          content: "sandbox write",
        });
        const written = await fs.readFile(path.join(sandboxDir, "new.txt"), "utf8");
        expect(written).toBe("sandbox write");

        await editTool?.execute("sbx-edit", {
          path: "new.txt",
          oldText: "write",
          newText: "edit",
        });
        const edited = await fs.readFile(path.join(sandboxDir, "new.txt"), "utf8");
        expect(edited).toBe("sandbox edit");
      });
    });
  });
});
