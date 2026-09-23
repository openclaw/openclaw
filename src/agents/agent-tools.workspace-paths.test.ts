/**
 * Tests workspace and cwd path selection during tool assembly.
 * Covers task cwd, spawned workspace inheritance, and sandbox path behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReadTool } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./sandbox/constants.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./sandbox/workspace-mounts.js";
import {
  expectReadWriteEditTools,
  expectReadWriteTools,
  getTextContent,
} from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { withUnsafeMountedSandboxHarness } from "./test-helpers/unsafe-mounted-sandbox.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

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
  if (!execTool) {
    throw new Error("expected exec tool");
  }
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
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("expected exec result cwd");
  }
  const [resolvedOutput, resolvedExpected] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(expectedDir),
  ]);
  expect(resolvedOutput).toBe(resolvedExpected);
}

describe("workspace path resolution", () => {
  it("uses cwd for coding filesystem tools while workspaceDir remains the agent workspace", async () => {
    await withTempDir("openclaw-agent-ws-", async (workspaceDir) => {
      await withTempDir("openclaw-task-cwd-", async (cwd) => {
        const tools = createOpenClawCodingTools({ workspaceDir, cwd });
        const { readTool, writeTool } = expectReadWriteEditTools(tools);

        await fs.writeFile(path.join(cwd, "task.txt"), "task cwd read ok", "utf8");
        const readResult = await readTool.execute("cwd-read", { path: "task.txt" });
        expect(getTextContent(readResult)).toContain("task cwd read ok");

        await writeTool.execute("cwd-write", { path: "created.txt", content: "task cwd write ok" });
        expect(await fs.readFile(path.join(cwd, "created.txt"), "utf8")).toBe("task cwd write ok");
        await expect(fs.access(path.join(workspaceDir, "created.txt"))).rejects.toThrow();
      });
    });
  });

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

  it.runIf(process.platform === "win32")(
    "preserves mixed-case and Unicode names for workspace-only writes on Windows",
    async () => {
      await withTempDir("openclaw-windows-case-", async (workspaceDir) => {
        const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
        const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
        const { writeTool } = expectReadWriteEditTools(tools);

        await writeTool.execute("windows-case-write", {
          path: "Source/İstanbul/Widget.ts",
          content: "export const Widget = true;",
        });

        await expect(fs.readdir(workspaceDir)).resolves.toEqual(["Source"]);
        await expect(fs.readdir(path.join(workspaceDir, "Source"))).resolves.toEqual(["İstanbul"]);
        await expect(fs.readdir(path.join(workspaceDir, "Source", "İstanbul"))).resolves.toEqual([
          "Widget.ts",
        ]);
      });
    },
  );

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

  it("defaults exec cwd to workspaceDir when workdir is omitted", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const execTool = createExecTool(workspaceDir);
      await expectExecCwdResolvesTo(execTool, "ws-exec", { command: "echo ok" }, workspaceDir);
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

  it.each([false, true])(
    "guards decoded file URLs with normalized forwarding=%s",
    async (normalizeGuardedPathParams) => {
      await withTempDir("openclaw-guard-url-", async (stateDir) => {
        const stateRoot = await fs.realpath(stateDir);
        const root = path.join(stateRoot, "workspace");
        const inside = path.join(root, "note.txt");
        const outside = path.join(stateRoot, "outside.txt");
        await fs.mkdir(root);
        await fs.writeFile(inside, "URL_INSIDE_MARKER");
        await fs.writeFile(outside, "URL_OUTSIDE_MARKER");
        const base = createReadTool(root) as unknown as AnyAgentTool;
        const execute = vi.spyOn(base, "execute");
        const read = wrapToolWorkspaceRootGuardWithOptions(base, root, {
          containerWorkdir: "/workspace",
          normalizeGuardedPathParams,
        });
        const insideUrl = pathToFileURL(inside).href;

        expect(getTextContent(await read.execute("inside-url", { path: insideUrl }))).toContain(
          "URL_INSIDE_MARKER",
        );
        expect(execute).toHaveBeenCalledWith(
          "inside-url",
          { path: normalizeGuardedPathParams ? inside : insideUrl },
          undefined,
          undefined,
        );
        await expect(
          read.execute("outside-url", { path: pathToFileURL(outside).href }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(inside, "utf8")).toBe("URL_INSIDE_MARKER");
        expect(await fs.readFile(outside, "utf8")).toBe("URL_OUTSIDE_MARKER");
      });
    },
  );

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

  it.runIf(process.platform !== "win32")(
    "writes through in-workspace symlink parents when workspaceOnly is enabled",
    async () => {
      await withTempDir("openclaw-ws-symlink-write-", async (workspaceDir) => {
        const realDir = path.join(workspaceDir, "oc_system", "memory");
        const aliasDir = path.join(workspaceDir, "memory");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, aliasDir);

        const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
        const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
        const { writeTool } = expectReadWriteEditTools(tools);

        await writeTool.execute("ws-write-symlink-parent", {
          path: "memory/2026-05-20.md",
          content: "remember this\n",
        });

        await expect(fs.readFile(path.join(realDir, "2026-05-20.md"), "utf8")).resolves.toBe(
          "remember this\n",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "edits through in-workspace symlink parents when workspaceOnly is enabled",
    async () => {
      await withTempDir("openclaw-ws-symlink-edit-", async (workspaceDir) => {
        const realDir = path.join(workspaceDir, "oc_system", "memory");
        const aliasDir = path.join(workspaceDir, "memory");
        const targetPath = path.join(realDir, "2026-05-20.md");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, aliasDir);
        await fs.writeFile(targetPath, "old memory\n", "utf8");

        const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
        const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
        const { editTool } = expectReadWriteEditTools(tools);

        await editTool.execute("ws-edit-symlink-parent", {
          path: "memory/2026-05-20.md",
          edits: [{ oldText: "old", newText: "new" }],
        });

        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("new memory\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects writes through symlink parents that resolve outside the workspace",
    async () => {
      await withTempDir("openclaw-ws-symlink-escape-", async (rootDir) => {
        const workspaceDir = path.join(rootDir, "workspace");
        const outsideDir = path.join(rootDir, "outside");
        const aliasDir = path.join(workspaceDir, "memory");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.symlink(outsideDir, aliasDir);

        const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
        const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
        const { writeTool } = expectReadWriteEditTools(tools);

        await expect(
          writeTool.execute("ws-write-symlink-escape", {
            path: "memory/secret.md",
            content: "pwned\n",
          }),
        ).rejects.toThrow(/Path escapes workspace root|outside-workspace|sandbox/i);
        await expect(fs.stat(path.join(outsideDir, "secret.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects writes to final symlinks when workspaceOnly is enabled",
    async () => {
      await withTempDir("openclaw-ws-symlink-leaf-", async (workspaceDir) => {
        const targetPath = path.join(workspaceDir, "target.md");
        const linkPath = path.join(workspaceDir, "memory.md");
        await fs.writeFile(targetPath, "original\n", "utf8");
        await fs.symlink(targetPath, linkPath);

        const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
        const tools = createOpenClawCodingTools({ workspaceDir, config: cfg });
        const { writeTool } = expectReadWriteEditTools(tools);

        await expect(
          writeTool.execute("ws-write-final-symlink", {
            path: "memory.md",
            content: "pwned\n",
          }),
        ).rejects.toThrow(/symlink|not-file|directory component/i);
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("original\n");
      });
    },
  );

  it("allows workspaceOnly reads for resolved skill roots without allowing other filesystem access", async () => {
    await withTempDir("openclaw-skill-read-", async (rootDir) => {
      const workspaceDir = path.join(rootDir, "workspace");
      const skillDir = path.join(rootDir, "global-skills", "demo");
      const siblingDir = path.join(rootDir, "global-skills", "other");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(skillDir, { recursive: true });
      await fs.mkdir(siblingDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      const guideFile = path.join(skillDir, "guide.md");
      const siblingFile = path.join(siblingDir, "SKILL.md");
      const outsideFile = path.join(rootDir, "outside.txt");
      await fs.writeFile(skillFile, "# Demo skill\noriginal skill\n", "utf8");
      await fs.writeFile(guideFile, "skill guide", "utf8");
      await fs.writeFile(siblingFile, "sibling skill", "utf8");
      await fs.writeFile(outsideFile, "outside secret", "utf8");

      const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: cfg,
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "demo" }],
          resolvedSkills: [
            createCanonicalFixtureSkill({
              name: "demo",
              description: "Demo skill",
              filePath: skillFile,
              baseDir: skillDir,
              source: "test",
            }),
          ],
        },
      });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      expect(getTextContent(await readTool.execute("read-skill", { path: skillFile }))).toContain(
        "original skill",
      );
      expect(
        getTextContent(await readTool.execute("read-skill-guide", { path: guideFile })),
      ).toContain("skill guide");
      await expect(readTool.execute("read-sibling", { path: siblingFile })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      await expect(readTool.execute("read-outside", { path: outsideFile })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      await expect(
        writeTool.execute("write-skill", { path: skillFile, content: "overwritten" }),
      ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
      await expect(
        editTool.execute("edit-skill", {
          path: skillFile,
          edits: [{ oldText: "original", newText: "edited" }],
        }),
      ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
      expect(await fs.readFile(skillFile, "utf8")).toContain("original skill");
    });
  });

  it("rejects symlink escapes inside resolved skill roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-skill-read-symlink-", async (rootDir) => {
      const workspaceDir = path.join(rootDir, "workspace");
      const skillDir = path.join(rootDir, "global-skills", "demo");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      const outsideFile = path.join(rootDir, "outside.txt");
      const linkPath = path.join(skillDir, "outside-link.txt");
      await fs.writeFile(skillFile, "# Demo skill\n", "utf8");
      await fs.writeFile(outsideFile, "outside secret", "utf8");
      await fs.symlink(outsideFile, linkPath);

      const cfg: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: cfg,
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "demo" }],
          resolvedSkills: [
            createCanonicalFixtureSkill({
              name: "demo",
              description: "Demo skill",
              filePath: skillFile,
              baseDir: skillDir,
              source: "test",
            }),
          ],
        },
      });
      const { readTool } = expectReadWriteEditTools(tools);

      await expect(readTool.execute("read-skill-symlink", { path: linkPath })).rejects.toThrow(
        /symlink|sandbox|outside|escape/i,
      );
    });
  });
});

describe("sandboxed workspace paths", () => {
  it("guards file URLs before registered legacy bridge reads", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      // Older external bridges omit descriptors but may expose additional roots.
      // Workspace admission must inspect the same decoded URL as the reader.
      const { pathMappings, ...legacyBridge } = sandbox.fsBridge!;
      expect(pathMappings).toBeDefined();
      sandbox.fsBridge = legacyBridge;
      const readFile = vi.spyOn(legacyBridge, "readFile");
      const stat = vi.spyOn(legacyBridge, "stat");
      const inside = path.join(sandboxRoot, "note.txt");
      const outside = path.join(agentRoot, "outside.txt");
      await fs.writeFile(inside, "LEGACY_URL_INSIDE_MARKER");
      await fs.writeFile(outside, "LEGACY_URL_OUTSIDE_MARKER");
      const tools = createOpenClawCodingTools({
        workspaceDir: sandboxRoot,
        sandbox,
        config: { tools: { fs: { workspaceOnly: true } } },
      });
      const { readTool } = expectReadWriteEditTools(tools);

      expect(
        getTextContent(
          await readTool.execute("legacy-inside-url", { path: pathToFileURL(inside).href }),
        ),
      ).toContain("LEGACY_URL_INSIDE_MARKER");
      const readsBefore = readFile.mock.calls.length;
      const statsBefore = stat.mock.calls.length;
      expect(readsBefore).toBeGreaterThan(0);
      expect(statsBefore).toBeGreaterThan(0);
      await expect(
        readTool.execute("legacy-outside-url", { path: pathToFileURL(outside).href }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(readFile).toHaveBeenCalledTimes(readsBefore);
      expect(stat).toHaveBeenCalledTimes(statsBefore);
      expect(await fs.readFile(inside, "utf8")).toBe("LEGACY_URL_INSIDE_MARKER");
      expect(await fs.readFile(outside, "utf8")).toBe("LEGACY_URL_OUTSIDE_MARKER");
    });
  });

  it("uses sandbox workspace for relative read/write/edit", async () => {
    await withTempDir("openclaw-sandbox-", async (sandboxDir) => {
      await withTempDir("openclaw-workspace-", async (workspaceDir) => {
        const sandbox = createAgentToolsSandboxContext({
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

type UnsafeMountedSandbox = Parameters<
  Parameters<typeof withUnsafeMountedSandboxHarness>[0]
>[0]["sandbox"];

const APPLY_PATCH_PAYLOAD = `*** Begin Patch
*** Add File: /agent/pwned.txt
+owned-by-apply-patch
*** End Patch`;

function patchSandbox(sandbox: UnsafeMountedSandbox) {
  const { workspaceDir: root, containerWorkdir: containerRoot, fsBridge } = sandbox;
  return { root, bridge: fsBridge!, workspaceMounts: [{ hostRoot: root, containerRoot }] };
}

function resolveApplyPatchTool(params: { sandbox: UnsafeMountedSandbox; config: OpenClawConfig }) {
  return createApplyPatchTool({
    cwd: params.sandbox.workspaceDir,
    sandbox: patchSandbox(params.sandbox),
    workspaceOnly: params.config.tools?.exec?.applyPatch?.workspaceOnly !== false,
  });
}

function createSandboxFsTools(params: { sandbox: UnsafeMountedSandbox; workspaceOnly?: boolean }) {
  const tools = [
    createSandboxedReadTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
    createSandboxedWriteTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
    createSandboxedEditTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
  ];
  if (!params.workspaceOnly) {
    return tools;
  }
  return tools.map((tool) =>
    wrapToolWorkspaceRootGuardWithOptions(tool, params.sandbox.workspaceDir, {
      containerMounts:
        tool.name === "read"
          ? [
              {
                hostRoot: params.sandbox.workspaceDir,
                containerRoot: params.sandbox.containerWorkdir,
              },
              ...(params.sandbox.workspaceAccess === "ro"
                ? [
                    {
                      containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
                      hostRoot: params.sandbox.agentWorkspaceDir,
                    },
                  ]
                : []),
              ...resolveReadOnlyWorkspaceSkillMounts({
                workspaceDir: params.sandbox.workspaceDir,
                agentWorkspaceDir: params.sandbox.agentWorkspaceDir,
                skillsWorkspaceDir: params.sandbox.skillsWorkspaceDir,
                workdir: params.sandbox.containerWorkdir,
                workspaceAccess: params.sandbox.workspaceAccess,
              }).map((mount) => ({
                containerRoot: mount.containerPath,
                hostRoot: mount.hostPath,
              })),
            ]
          : undefined,
      containerWorkdir: params.sandbox.containerWorkdir,
    }),
  );
}

describe("tools.fs.workspaceOnly", () => {
  it("preserves valid UTF-8 BOM bytes through real sandbox edit and patch bridges", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, sandbox }) => {
      const filePath = path.join(sandboxRoot, "source.txt");
      const original = Buffer.from("\uFEFFheading\nprice: 5\n", "utf8");
      const expected = Buffer.from("\uFEFFheading\nprice: 7\n", "utf8");
      const editTool = createSandboxedEditTool({
        root: sandbox.workspaceDir,
        bridge: sandbox.fsBridge!,
      });

      await fs.writeFile(filePath, original);
      await editTool.execute("sandbox-edit-bom", {
        path: "source.txt",
        edits: [{ oldText: "price: 5", newText: "price: 7" }],
      });
      await expect(fs.readFile(filePath)).resolves.toEqual(expected);

      await fs.writeFile(filePath, original);
      const patchTool = createApplyPatchTool({
        cwd: sandbox.workspaceDir,
        sandbox: patchSandbox(sandbox),
      });
      await patchTool.execute("sandbox-patch-bom", {
        input: `*** Begin Patch
*** Update File: source.txt
@@
-price: 5
+price: 7
*** End Patch`,
      });
      await expect(fs.readFile(filePath)).resolves.toEqual(expected);
    });
  });

  it("preserves unrelated Unicode bytes through the real sandbox edit bridge", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, sandbox }) => {
      const filePath = path.join(sandboxRoot, "source.txt");
      const original =
        "const value\u00A0= 1; // keep \uFF08\uFF13\uFF09 \uFF71\uFF72\uFF73 \u2014 unchanged\r\n";
      const expected =
        "const value = 2; // keep \uFF08\uFF13\uFF09 \uFF71\uFF72\uFF73 \u2014 unchanged\r\n";
      const editTool = createSandboxedEditTool({
        root: sandbox.workspaceDir,
        bridge: sandbox.fsBridge!,
      });

      await fs.writeFile(filePath, original, "utf8");
      await editTool.execute("sandbox-edit-fuzzy-unicode", {
        path: "source.txt",
        edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
      });

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(expected);
    });
  });

  it("rejects invalid UTF-8 before sandbox edit or patch bridge writes", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, sandbox }) => {
      const filePath = path.join(sandboxRoot, "source.txt");
      const original = Buffer.concat([
        Buffer.from("heading\nprice: 5\n"),
        Buffer.from([0xff, 0xfe]),
      ]);
      await fs.writeFile(filePath, original);
      const editTool = createSandboxedEditTool({
        root: sandbox.workspaceDir,
        bridge: sandbox.fsBridge!,
      });

      await expect(
        editTool.execute("sandbox-edit-invalid-utf8", {
          path: "source.txt",
          edits: [{ oldText: "price: 5", newText: "price: 7" }],
        }),
      ).rejects.toThrow(/not valid UTF-8/);
      await expect(fs.readFile(filePath)).resolves.toEqual(original);

      const patchTool = createApplyPatchTool({
        cwd: sandbox.workspaceDir,
        sandbox: patchSandbox(sandbox),
      });
      await expect(
        patchTool.execute("sandbox-patch-invalid-utf8", {
          input: `*** Begin Patch
*** Update File: source.txt
@@
-price: 5
+price: 7
*** End Patch`,
        }),
      ).rejects.toThrow(/not valid UTF-8/);
      await expect(fs.readFile(filePath)).resolves.toEqual(original);
    });
  });

  it("defaults to allowing sandbox mounts outside the workspace root", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const tools = createSandboxFsTools({ sandbox });
      const { readTool, writeTool } = expectReadWriteTools(tools);

      const readResult = await readTool?.execute("t1", { path: "/agent/secret.txt" });
      expect(getTextContent(readResult)).toContain("shh");

      await writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" });
      expect(await fs.readFile(path.join(agentRoot, "owned.txt"), "utf8")).toBe("x");
    });
  });

  it("rejects sandbox mounts outside the workspace root when enabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const tools = createSandboxFsTools({ sandbox, workspaceOnly: true });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      await expect(readTool?.execute("t1", { path: "/agent/secret.txt" })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );

      await expect(
        writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      const missingOwnedFile = await fs
        .stat(path.join(agentRoot, "owned.txt"))
        .catch((error: unknown) => error);
      expect((missingOwnedFile as NodeJS.ErrnoException).code).toBe("ENOENT");

      await expect(
        editTool?.execute("t3", { path: "/agent/secret.txt", oldText: "shh", newText: "nope" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(await fs.readFile(path.join(agentRoot, "secret.txt"), "utf8")).toBe("shh");
    });
  });

  it("allows read-only agent workspace mounts for sandbox reads only", async () => {
    await withUnsafeMountedSandboxHarness(
      async ({ agentRoot, sandbox }) => {
        await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

        const tools = createSandboxFsTools({ sandbox, workspaceOnly: true });
        const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

        const readResult = await readTool?.execute("t1", { path: "/agent/secret.txt" });
        expect(getTextContent(readResult)).toContain("shh");

        await expect(
          writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        const missingOwnedFile = await fs
          .stat(path.join(agentRoot, "owned.txt"))
          .catch((error: unknown) => error);
        expect((missingOwnedFile as NodeJS.ErrnoException).code).toBe("ENOENT");

        await expect(
          editTool?.execute("t3", { path: "/agent/secret.txt", oldText: "shh", newText: "nope" }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        expect(await fs.readFile(path.join(agentRoot, "secret.txt"), "utf8")).toBe("shh");
      },
      { workspaceAccess: "ro" },
    );
  });

  it("allows read-only materialized sandbox skills for sandbox reads only", async () => {
    await withUnsafeMountedSandboxHarness(
      async ({ sandbox, skillsWorkspaceDir }) => {
        expect(skillsWorkspaceDir).toBeTruthy();
        const skillDir = path.join(skillsWorkspaceDir!, "skills", "demo");
        const userOwnedShadowDir = path.join(
          sandbox.workspaceDir,
          ".openclaw",
          "sandbox-skills",
          "skills",
          "demo",
        );
        await fs.mkdir(skillDir, { recursive: true });
        await fs.mkdir(userOwnedShadowDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\nmaterialized\n", "utf8");
        await fs.writeFile(
          path.join(userOwnedShadowDir, "SKILL.md"),
          "# Demo\nuser-owned shadow\n",
          "utf8",
        );

        const tools = createSandboxFsTools({ sandbox, workspaceOnly: true });
        const { readTool } = expectReadWriteEditTools(tools);
        const containerSkillPath = "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md";

        const readResult = await readTool?.execute("t1", { path: containerSkillPath });
        expect(getTextContent(readResult)).toContain("materialized");
        expect(getTextContent(readResult)).not.toContain("user-owned shadow");
        const relativeReadResult = await readTool?.execute("t2", {
          path: ".openclaw/sandbox-skills/skills/demo/SKILL.md",
        });
        expect(getTextContent(relativeReadResult)).toContain("materialized");
        expect(getTextContent(relativeReadResult)).not.toContain("user-owned shadow");
        const fileUrlReadResult = await readTool?.execute("t3", {
          path: "file:///workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
        });
        expect(getTextContent(fileUrlReadResult)).toContain("materialized");
        expect(getTextContent(fileUrlReadResult)).not.toContain("user-owned shadow");
        expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toContain(
          "materialized",
        );
        expect(await fs.readFile(path.join(userOwnedShadowDir, "SKILL.md"), "utf8")).toContain(
          "user-owned shadow",
        );
      },
      { includeSkillsWorkspace: true, workspaceAccess: "rw" },
    );
  });

  it("enforces apply_patch workspace-only in sandbox mounts by default", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      const applyPatchTool = resolveApplyPatchTool({
        sandbox,
        config: {
          tools: {
            allow: ["read", "write", "exec"],
            exec: { applyPatch: {} },
          },
        } as OpenClawConfig,
      });

      await expect(applyPatchTool.execute("t1", { input: APPLY_PATCH_PAYLOAD })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      const missingPatchedFile = await fs
        .stat(path.join(agentRoot, "pwned.txt"))
        .catch((error: unknown) => error);
      expect((missingPatchedFile as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  it("allows apply_patch outside workspace root when explicitly disabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      const applyPatchTool = resolveApplyPatchTool({
        sandbox,
        config: {
          tools: {
            allow: ["read", "write", "exec"],
            exec: { applyPatch: { workspaceOnly: false } },
          },
        } as OpenClawConfig,
      });

      await applyPatchTool.execute("t2", { input: APPLY_PATCH_PAYLOAD });
      expect(await fs.readFile(path.join(agentRoot, "pwned.txt"), "utf8")).toBe(
        "owned-by-apply-patch\n",
      );
    });
  });
});

vi.mock("openclaw/plugin-sdk/llm", async () => {
  const original =
    await vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm");
  return {
    ...original,
  };
});
