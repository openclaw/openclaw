import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReadTool } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { wrapToolWorkspaceRootGuardWithOptions } from "./agent-tools.read.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  expectReadWriteEditTools,
  expectReadWriteTools,
  getTextContent,
} from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { withUnsafeMountedSandboxHarness } from "./test-helpers/unsafe-mounted-sandbox.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});
function workspaceTools(workspaceDir: string) {
  return expectReadWriteEditTools(
    createOpenClawCodingTools({
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: true } } },
    }),
  );
}

async function withSkillWorkspace(
  run: (fixture: {
    rootDir: string;
    skillDir: string;
    skillFile: string;
    tools: ReturnType<typeof workspaceTools>;
  }) => Promise<void>,
) {
  await withTempDir("openclaw-skill-read-", async (rootDir) => {
    const workspaceDir = path.join(rootDir, "workspace");
    const skillDir = path.join(rootDir, "global-skills/demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, "# Demo skill\noriginal skill\n");
    const tools = expectReadWriteEditTools(
      createOpenClawCodingTools({
        workspaceDir,
        config: { tools: { fs: { workspaceOnly: true } } },
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
      }),
    );
    await run({ rootDir, skillDir, skillFile, tools });
  });
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

  it.runIf(process.platform === "win32")(
    "preserves mixed-case and Unicode names for workspace-only writes on Windows",
    async () => {
      await withTempDir("openclaw-windows-case-", async (workspaceDir) => {
        const { writeTool } = workspaceTools(workspaceDir);

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

  it("defaults exec cwd to workspaceDir when workdir is omitted", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const exec = createOpenClawCodingTools({
        workspaceDir,
        exec: { host: "gateway", ask: "off", security: "full" },
      }).find((tool) => tool.name === "exec");
      if (!exec) {
        throw new Error("expected exec tool");
      }
      const result = await exec.execute("cwd", { command: "echo ok" });
      const details = result.details;
      if (
        !details ||
        typeof details !== "object" ||
        !("cwd" in details) ||
        typeof details.cwd !== "string"
      ) {
        throw new Error("expected exec result cwd");
      }
      expect(await fs.realpath(details.cwd)).toBe(await fs.realpath(workspaceDir));
    });
  });

  it("rejects @-prefixed absolute paths outside workspace when workspaceOnly is enabled", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const { readTool } = workspaceTools(workspaceDir);

      const outsideAbsolute = path.resolve(path.parse(workspaceDir).root, "outside-openclaw.txt");
      await expect(
        readTool.execute("ws-read-at-prefix", { path: `@${outsideAbsolute}` }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
    });
  });

  it("guards decoded file URLs while forwarding the original URL", async () => {
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
        normalizeGuardedPathParams: false,
      });
      const insideUrl = pathToFileURL(inside).href;

      expect(getTextContent(await read.execute("inside-url", { path: insideUrl }))).toContain(
        "URL_INSIDE_MARKER",
      );
      expect(execute).toHaveBeenCalledWith("inside-url", { path: insideUrl }, undefined, undefined);
      await expect(
        read.execute("outside-url", { path: pathToFileURL(outside).href }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(inside, "utf8")).toBe("URL_INSIDE_MARKER");
      expect(await fs.readFile(outside, "utf8")).toBe("URL_OUTSIDE_MARKER");
    });
  });

  it.runIf(process.platform !== "win32")("rejects hardlinked file aliases", async () => {
    await withTempDir("openclaw-hardlinks-", async (parent) => {
      const workspaceDir = path.join(parent, "workspace");
      const outside = path.join(parent, "outside.txt");
      await fs.mkdir(workspaceDir);
      await fs.writeFile(outside, "top-secret");
      await fs.link(outside, path.join(workspaceDir, "linked.txt"));
      const { readTool, writeTool } = workspaceTools(workspaceDir);
      await expect(readTool.execute("read", { path: "linked.txt" })).rejects.toThrow(
        /hardlink|sandbox/i,
      );
      await expect(
        writeTool.execute("write", { path: "linked.txt", content: "pwned" }),
      ).rejects.toThrow(/hardlink|sandbox/i);
      expect(await fs.readFile(outside, "utf8")).toBe("top-secret");
    });
  });

  it.runIf(process.platform !== "win32").each(["write", "edit"] as const)(
    "%s follows in-workspace symlink parents",
    async (operation) => {
      await withTempDir("openclaw-symlink-parent-", async (workspaceDir) => {
        const realDir = path.join(workspaceDir, "real");
        await fs.mkdir(realDir);
        await fs.symlink(realDir, path.join(workspaceDir, "memory"));
        const target = path.join(realDir, "note.md");
        await fs.writeFile(target, "old memory\n");
        const { writeTool, editTool } = workspaceTools(workspaceDir);
        if (operation === "write") {
          await writeTool.execute("write", { path: "memory/note.md", content: "new memory\n" });
        } else {
          await editTool.execute("edit", {
            path: "memory/note.md",
            edits: [{ oldText: "old", newText: "new" }],
          });
        }
        await expect(fs.readFile(target, "utf8")).resolves.toBe("new memory\n");
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

        const { writeTool } = workspaceTools(workspaceDir);

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

        const { writeTool } = workspaceTools(workspaceDir);

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
    await withSkillWorkspace(
      async ({ rootDir, skillDir, skillFile, tools: { readTool, writeTool, editTool } }) => {
        const guideFile = path.join(skillDir, "guide.md");
        const siblingFile = path.join(rootDir, "global-skills/other/SKILL.md");
        const outsideFile = path.join(rootDir, "outside.txt");
        await fs.mkdir(path.dirname(siblingFile));
        await fs.writeFile(guideFile, "skill guide");
        await fs.writeFile(siblingFile, "sibling skill");
        await fs.writeFile(outsideFile, "outside secret");

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
      },
    );
  });

  it("rejects symlink escapes inside resolved skill roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withSkillWorkspace(async ({ rootDir, skillDir, tools: { readTool } }) => {
      const outsideFile = path.join(rootDir, "outside.txt");
      const linkPath = path.join(skillDir, "outside-link.txt");
      await fs.writeFile(outsideFile, "outside secret");
      await fs.symlink(outsideFile, linkPath);

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

const APPLY_PATCH_PAYLOAD =
  "*** Begin Patch\n*** Add File: /agent/pwned.txt\n+owned-by-apply-patch\n*** End Patch";

function patchSandbox(sandbox: UnsafeMountedSandbox) {
  const { workspaceDir: root, containerWorkdir: containerRoot, fsBridge } = sandbox;
  return { root, bridge: fsBridge!, workspaceMounts: [{ hostRoot: root, containerRoot }] };
}

function resolveApplyPatchTool(sandbox: UnsafeMountedSandbox) {
  return createApplyPatchTool({
    cwd: sandbox.workspaceDir,
    sandbox: patchSandbox(sandbox),
  });
}

describe("tools.fs.workspaceOnly", () => {
  it("defaults to allowing sandbox mounts outside the workspace root", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh");
      const { readTool, writeTool } = expectReadWriteTools(
        createOpenClawCodingTools({
          workspaceDir: sandbox.workspaceDir,
          sandbox,
        }),
      );
      expect(
        getTextContent(await readTool.execute("read", { path: "/agent/secret.txt" })),
      ).toContain("shh");
      await writeTool.execute("write", { path: "/agent/owned.txt", content: "x" });
      expect(await fs.readFile(path.join(agentRoot, "owned.txt"), "utf8")).toBe("x");
    });
  });

  it("allows read-only materialized sandbox skills for sandbox reads only", async () => {
    await withUnsafeMountedSandboxHarness(
      async ({ sandbox, skillsWorkspaceDir }) => {
        expect(skillsWorkspaceDir).toBeTruthy();
        const skillDir = path.join(skillsWorkspaceDir!, "skills", "demo");
        const userOwnedShadowDir = path.join(
          sandbox.workspaceDir,
          ".openclaw/sandbox-skills/skills/demo",
        );
        await fs.mkdir(skillDir, { recursive: true });
        await fs.mkdir(userOwnedShadowDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\nmaterialized\n", "utf8");
        await fs.writeFile(
          path.join(userOwnedShadowDir, "SKILL.md"),
          "# Demo\nuser-owned shadow\n",
          "utf8",
        );

        const tools = createOpenClawCodingTools({
          workspaceDir: sandbox.workspaceDir,
          sandbox,
          config: { tools: { fs: { workspaceOnly: true } } },
        });
        const { readTool } = expectReadWriteEditTools(tools);
        for (const filePath of [
          "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
          ".openclaw/sandbox-skills/skills/demo/SKILL.md",
          "file:///workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
        ]) {
          const text = getTextContent(await readTool.execute("skill", { path: filePath }));
          expect(text).toContain("materialized");
          expect(text).not.toContain("user-owned shadow");
        }
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
      const applyPatchTool = resolveApplyPatchTool(sandbox);

      await expect(applyPatchTool.execute("t1", { input: APPLY_PATCH_PAYLOAD })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      const missingPatchedFile = await fs
        .stat(path.join(agentRoot, "pwned.txt"))
        .catch((error: unknown) => error);
      expect((missingPatchedFile as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });
});
