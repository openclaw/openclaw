import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  createRebindableDirectoryAlias,
  withRealpathSymlinkRebindRace,
} from "../test-utils/symlink-rebind-race.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/pi-tools-fs-helpers.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
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

function createExecTool(workspaceDir: string) {
  const tools = createOpenClawCodingTools({
    workspaceDir,
    exec: { host: "gateway", ask: "off", security: "full" },
  });
  const execTool = tools.find((tool) => tool.name === "exec");
  expect(execTool).toBeDefined();
  return execTool;
}

async function expectExecCwdResolvesTo(
  execTool: ReturnType<typeof createExecTool>,
  callId: string,
  params: { command: string; workdir?: string },
  expectedDir: string,
) {
  const result = await execTool?.execute(callId, params);
  const cwd =
    result?.details && typeof result.details === "object" && "cwd" in result.details
      ? (result.details as { cwd?: string }).cwd
      : undefined;
  expect(cwd).toBeTruthy();
  const [resolvedOutput, resolvedExpected] = await Promise.all([
    fs.realpath(String(cwd)),
    fs.realpath(expectedDir),
  ]);
  expect(resolvedOutput).toBe(resolvedExpected);
}

describe("workspace path resolution", () => {
  it("resolves relative read/write/edit paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-cwd-", async (otherDir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherDir);
        try {
          const tools = createOpenClawCodingTools({ workspaceDir });
          const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

          const readFile = "read.txt";
          await fs.writeFile(path.join(workspaceDir, readFile), "workspace read ok", "utf8");
          const readResult = await readTool.execute("ws-read", { path: readFile });
          expect(getTextContent(readResult)).toContain("workspace read ok");

          const writeFile = "write.txt";
          await writeTool.execute("ws-write", {
            path: writeFile,
            content: "workspace write ok",
          });
          expect(await fs.readFile(path.join(workspaceDir, writeFile), "utf8")).toBe(
            "workspace write ok",
          );

          const editFile = "edit.txt";
          await fs.writeFile(path.join(workspaceDir, editFile), "hello world", "utf8");
          await editTool.execute("ws-edit", {
            path: editFile,
            edits: [{ oldText: "world", newText: "openclaw" }],
          });
          expect(await fs.readFile(path.join(workspaceDir, editFile), "utf8")).toBe(
            "hello openclaw",
          );
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  it("allows deletion edits with empty newText", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-cwd-", async (otherDir) => {
        const testFile = "delete.txt";
        await fs.writeFile(path.join(workspaceDir, testFile), "hello world", "utf8");

        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherDir);
        try {
          const tools = createOpenClawCodingTools({ workspaceDir });
          const { editTool } = expectReadWriteEditTools(tools);

          await editTool.execute("ws-edit-delete", {
            path: testFile,
            edits: [{ oldText: " world", newText: "" }],
          });

          expect(await fs.readFile(path.join(workspaceDir, testFile), "utf8")).toBe("hello");
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  it("supports multi-edit edits[] payloads", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-cwd-", async (otherDir) => {
        const testFile = "batch.txt";
        await fs.writeFile(path.join(workspaceDir, testFile), "alpha beta gamma delta", "utf8");

        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherDir);
        try {
          const tools = createOpenClawCodingTools({ workspaceDir });
          const { editTool } = expectReadWriteEditTools(tools);

          await editTool.execute("ws-edit-batch", {
            path: testFile,
            edits: [
              { oldText: "alpha", newText: "ALPHA" },
              { oldText: "delta", newText: "DELTA" },
            ],
          });

          expect(await fs.readFile(path.join(workspaceDir, testFile), "utf8")).toBe(
            "ALPHA beta gamma DELTA",
          );
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  it("defaults exec cwd to workspaceDir when workdir is omitted", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const execTool = createExecTool(workspaceDir);
      await expectExecCwdResolvesTo(execTool, "ws-exec", { command: "echo ok" }, workspaceDir);
    });
  });

  it("lets exec workdir override the workspace default", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-override-", async (overrideDir) => {
        const execTool = createExecTool(workspaceDir);
        await expectExecCwdResolvesTo(
          execTool,
          "ws-exec-override",
          { command: "echo ok", workdir: overrideDir },
          overrideDir,
        );
      });
    });
  });

  it("rejects @-prefixed absolute paths outside workspace when workspaceOnly is enabled", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
      const { readTool } = expectReadWriteEditTools(tools);

      const outsideAbsolute = path.resolve(path.parse(workspaceDir).root, "outside-openclaw.txt");
      await expect(
        readTool.execute("ws-read-at-prefix", { path: `@${outsideAbsolute}` }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
    });
  });

  it("rejects hardlinked file aliases when workspaceOnly is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
      const { readTool, writeTool } = expectReadWriteEditTools(tools);
      const outsidePath = path.join(
        path.dirname(workspaceDir),
        `outside-hardlink-${process.pid}-${Date.now()}.txt`,
      );
      const hardlinkPath = path.join(workspaceDir, "linked.txt");
      await fs.writeFile(outsidePath, "top-secret", "utf8");
      try {
        try {
          await fs.link(outsidePath, hardlinkPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw err;
        }
        await expect(readTool.execute("ws-read-hardlink", { path: "linked.txt" })).rejects.toThrow(
          /hardlink|sandbox/i,
        );
        await expect(
          writeTool.execute("ws-write-hardlink", {
            path: "linked.txt",
            content: "pwned",
          }),
        ).rejects.toThrow(/hardlink|sandbox/i);
        expect(await fs.readFile(outsidePath, "utf8")).toBe("top-secret");
      } finally {
        await fs.rm(hardlinkPath, { force: true });
        await fs.rm(outsidePath, { force: true });
      }
    });
  });

  it("allows includedWorkDirs when workspaceOnly is enabled", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-extra-", async (includedDir) => {
        const cfg: OpenClawConfig = {
          tools: { fs: { workspaceOnly: true } },
          agents: {
            list: [{ id: "main", workspace: workspaceDir, includedWorkDirs: [includedDir] }],
          },
        };
        const tools = createOpenClawCodingTools({
          config: cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });
        const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

        const target = path.join(includedDir, "included.txt");
        await fs.writeFile(target, "hello world", "utf8");

        const readResult = await readTool.execute("included-read", { path: target });
        expect(getTextContent(readResult)).toContain("hello world");

        await writeTool.execute("included-write", {
          path: target,
          content: "hello openclaw",
        });
        expect(await fs.readFile(target, "utf8")).toBe("hello openclaw");

        await editTool.execute("included-edit", {
          path: target,
          edits: [{ oldText: "openclaw", newText: "workflow" }],
        });
        expect(await fs.readFile(target, "utf8")).toBe("hello workflow");
      });
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps includedWorkDirs writes and edits pinned when an alias is rebound after validation",
    async () => {
      await withTempDir("openclaw-ws-", async (workspaceDir) => {
        await withTempDir("openclaw-extra-", async (includedDir) => {
          const inside = path.join(includedDir, "inside");
          const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extra-outside-"));
          const slot = path.join(includedDir, "slot");
          const insideTarget = path.join(inside, "safe.txt");
          const outsideTarget = path.join(outside, "safe.txt");
          await fs.mkdir(inside, { recursive: true });
          await fs.writeFile(insideTarget, "safe\n", "utf8");
          await fs.writeFile(outsideTarget, "outside\n", "utf8");
          await createRebindableDirectoryAlias({
            aliasPath: slot,
            targetPath: inside,
          });

          const cfg: OpenClawConfig = {
            tools: { fs: { workspaceOnly: true } },
            agents: {
              list: [{ id: "main", workspace: workspaceDir, includedWorkDirs: [includedDir] }],
            },
          };
          const tools = createOpenClawCodingTools({
            config: cfg,
            sessionKey: "agent:main:main",
            workspaceDir,
          });
          const { writeTool, editTool } = expectReadWriteEditTools(tools);
          const target = path.join(slot, "safe.txt");

          try {
            await withRealpathSymlinkRebindRace({
              shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot", "safe.txt")),
              symlinkPath: slot,
              symlinkTarget: outside,
              timing: "after-realpath",
              run: async () => {
                await expect(
                  writeTool.execute("included-write-race", {
                    path: target,
                    content: "mutated\n",
                  }),
                ).rejects.toThrow(
                  /allowed work roots|workspace root|outside|under root|sandbox|path alias escape blocked/i,
                );
              },
            });
            expect(await fs.readFile(outsideTarget, "utf8")).toBe("outside\n");
            expect(await fs.readFile(insideTarget, "utf8")).toBe("safe\n");

            await createRebindableDirectoryAlias({
              aliasPath: slot,
              targetPath: inside,
            });
            await withRealpathSymlinkRebindRace({
              shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot", "safe.txt")),
              symlinkPath: slot,
              symlinkTarget: outside,
              timing: "after-realpath",
              run: async () => {
                await expect(
                  editTool.execute("included-edit-race", {
                    path: target,
                    edits: [{ oldText: "safe", newText: "mutated" }],
                  }),
                ).rejects.toThrow(
                  /allowed work roots|workspace root|outside|under root|sandbox|path alias escape blocked/i,
                );
              },
            });
            expect(await fs.readFile(outsideTarget, "utf8")).toBe("outside\n");
            expect(await fs.readFile(insideTarget, "utf8")).toBe("safe\n");
          } finally {
            await fs.rm(outside, { recursive: true, force: true });
          }
        });
      });
    },
  );
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
          edits: [{ oldText: "write", newText: "edit" }],
        });
        const edited = await fs.readFile(path.join(sandboxDir, "new.txt"), "utf8");
        expect(edited).toBe("sandbox edit");
      });
    });
  });
});
