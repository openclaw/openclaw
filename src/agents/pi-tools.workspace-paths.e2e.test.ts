import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

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
        const sandbox = {
          enabled: true,
          sessionKey: "sandbox:test",
          workspaceDir: sandboxDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          containerName: "openclaw-sbx-test",
          containerWorkdir: "/workspace",
          fsBridge: createHostSandboxFsBridge(sandboxDir),
          docker: {
            image: "openclaw-sandbox:bookworm-slim",
            containerPrefix: "openclaw-sbx-",
            workdir: "/workspace",
            readOnlyRoot: true,
            tmpfs: [],
            network: "none",
            user: "1000:1000",
            capDrop: ["ALL"],
            env: { LANG: "C.UTF-8" },
          },
          tools: { allow: [], deny: [] },
          browserAllowHostControl: false,
        };

        const testFile = "sandbox.txt";
        await fs.writeFile(path.join(sandboxDir, testFile), "sandbox read", "utf8");
        await fs.writeFile(path.join(workspaceDir, testFile), "workspace read", "utf8");

        const tools = createOpenClawCodingTools({ workspaceDir, sandbox });
        const readTool = tools.find((tool) => tool.name === "read");
        const writeTool = tools.find((tool) => tool.name === "write");
        const editTool = tools.find((tool) => tool.name === "edit");

        expect(readTool).toBeDefined();
        expect(writeTool).toBeDefined();
        expect(editTool).toBeDefined();

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
