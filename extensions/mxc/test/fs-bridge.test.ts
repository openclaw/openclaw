import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, test } from "vitest";
import { createMxcFsBridge } from "../src/fs-bridge.js";

async function makeWorkspace() {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-mxc-",
  });
  return Object.assign(workspace, { root: await fs.realpath(workspace.dir) });
}

async function writeFile(root: string, relative: string, content: string) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const skillRelative = path.join(".openclaw", "sandbox-skills", "skills", "demo", "SKILL.md");
const materializedSkill = path.join("skills", "demo", "SKILL.md");
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const readText = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");

function createDirectoryReader(params: {
  workspaceDir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
}) {
  const bridge = createMxcFsBridge({
    sandbox: {
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      workspaceAccess: params.workspaceAccess ?? "rw",
      containerName: "mxc-directory-test",
      containerWorkdir: params.workspaceDir,
      docker: {},
    },
  });
  return expectDefined(bridge.readDirectory?.bind(bridge), "MXC directory reader");
}

describe("MXC filesystem directory reads", () => {
  test("returns entry names and directory types relative to the mounted directory", async () => {
    await using workspace = await makeWorkspace();
    const workspaceDir = workspace.root;
    await writeFile(workspaceDir, "readme.md", "readme");
    await writeFile(workspaceDir, "notes/one.txt", "note");
    const readDirectory = createDirectoryReader({ workspaceDir });

    await expect(readDirectory({ filePath: "." })).resolves.toEqual([
      { name: "notes", isDirectory: true },
      { name: "readme.md", isDirectory: false },
    ]);
    await expect(
      readDirectory({ filePath: ".", cwd: path.join(workspaceDir, "notes") }),
    ).resolves.toEqual([{ name: "one.txt", isDirectory: false }]);
  });

  test.each([
    { workspaceAccess: "none", expectedName: "sandbox.txt" },
    { workspaceAccess: "ro", expectedName: "sandbox.txt" },
    { workspaceAccess: "rw", expectedName: "agent.txt" },
  ] as const)("uses the mounted workspace with access $workspaceAccess", async (scenario) => {
    await using workspace = await makeWorkspace();
    const root = workspace.root;
    const workspaceDir = path.join(root, "sandbox");
    const agentWorkspaceDir = path.join(root, "agent");
    await writeFile(workspaceDir, "sandbox.txt", "sandbox");
    await writeFile(agentWorkspaceDir, "agent.txt", "agent");
    const readDirectory = createDirectoryReader({
      workspaceDir,
      agentWorkspaceDir,
      workspaceAccess: scenario.workspaceAccess,
    });

    await expect(readDirectory({ filePath: workspaceDir })).resolves.toEqual([
      { name: scenario.expectedName, isDirectory: false },
    ]);
    if (scenario.workspaceAccess === "ro") {
      await expect(readDirectory({ filePath: agentWorkspaceDir })).resolves.toEqual([
        { name: "agent.txt", isDirectory: false },
      ]);
    } else {
      await expect(readDirectory({ filePath: agentWorkspaceDir })).rejects.toThrow(
        "Path escapes sandbox root",
      );
    }
    await expect(readDirectory({ filePath: root })).rejects.toThrow("Path escapes sandbox root");
  });

  test("lists the protected skill mount instead of its workspace shadow", async () => {
    await using workspace = await makeWorkspace();
    const root = workspace.root;
    const workspaceDir = path.join(root, "sandbox");
    const skillsWorkspaceDir = path.join(root, "materialized");
    const skillPath = path.join(".openclaw", "sandbox-skills", "skills");
    await fs.mkdir(path.join(workspaceDir, skillPath, "shadow"), { recursive: true });
    await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    const readDirectory = createDirectoryReader({ workspaceDir, skillsWorkspaceDir });

    await expect(readDirectory({ filePath: skillPath })).resolves.toEqual([
      { name: "demo", isDirectory: true },
    ]);
  });

  test("rejects a directory symlink that escapes the mounted root", async () => {
    await using workspace = await makeWorkspace();
    const root = workspace.root;
    const workspaceDir = path.join(root, "sandbox");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "private.txt"), "outside");
    await fs.symlink(
      outsideDir,
      path.join(workspaceDir, "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const readDirectory = createDirectoryReader({ workspaceDir });

    await expect(readDirectory({ filePath: "outside-link" })).rejects.toThrow(
      "path alias escape blocked",
    );
  });
});

// Run unchanged on native Windows too: these are the bridge's real native paths,
// through the public SDK factory, without a launcher or transport mock.
describe("MXC public coding-tool composition", () => {
  test.each([true, false])(
    "uses native workspace mappings with workspaceOnly=%s",
    async (workspaceOnly) => {
      await using workspace = await makeWorkspace();
      const root = workspace.root;
      const workspaceDir = path.join(root, "sandbox");
      const agentWorkspaceDir = path.join(root, "agent");
      const skillsWorkspaceDir = path.join(root, "materialized");
      await writeFile(skillsWorkspaceDir, materializedSkill, "CONTENT_SKILL");
      await writeFile(agentWorkspaceDir, "agent.txt", "CONTENT_AGENT");
      await writeFile(workspaceDir, "agent.txt", "CONTENT_SHADOW");
      await writeFile(root, "outside.txt", "CONTENT_OUTSIDE");
      const makeTools = (workspaceAccess: "none" | "ro" | "rw") => {
        const sandbox = createSandboxTestContext({
          overrides: {
            backendId: "mxc",
            sessionKey: "agent:main:mxc-tools",
            workspaceDir,
            agentWorkspaceDir,
            skillsWorkspaceDir,
            workspaceAccess,
            runtimeId: "mxc-tools",
            runtimeLabel: "mxc-tools",
            containerName: "mxc-tools",
            containerWorkdir: workspaceDir,
            tools: { allow: [], deny: [] },
          },
          dockerOverrides: {
            image: "unused",
            containerPrefix: "unused",
            workdir: workspaceDir,
            readOnlyRoot: true,
            env: {},
          },
        });
        sandbox.fsBridge = createMxcFsBridge({ sandbox });
        const tools = createOpenClawCodingTools({
          sandbox,
          workspaceDir,
          cwd: workspaceDir,
          wrapBeforeToolCallHook: false,
          toolConstructionPlan: {
            includeBaseCodingTools: true,
            includeShellTools: true,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
          config: {
            tools: {
              allow: ["read", "write", "edit", "ls", "apply_patch"],
              fs: { workspaceOnly },
              exec: { applyPatch: { enabled: true, workspaceOnly } },
            },
          },
        });
        if (workspaceAccess === "ro") {
          for (const name of ["write", "edit", "apply_patch"]) {
            expect(tools.some((tool) => tool.name === name)).toBe(false);
          }
        }
        return (name: string, args: unknown) =>
          expectDefined(
            tools.find((tool) => tool.name === name),
            `Missing ${name}`,
          ).execute(name, args);
      };
      const text = (result: Awaited<ReturnType<AnyAgentTool["execute"]>>) =>
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      const rw = makeTools("rw");
      for (const filePath of ["note.txt", path.join(workspaceDir, "note.txt")]) {
        await rw("write", { path: filePath, content: "original\n" });
        await rw("edit", {
          path: filePath,
          edits: [{ oldText: "original", newText: "edited" }],
        });
        expect(text(await rw("read", { path: filePath }))).toContain("edited");
        await rw("apply_patch", {
          input: patch(`*** Update File: ${filePath}`, "@@", "-edited", "+patched"),
        });
        expect(await readText(agentWorkspaceDir, "note.txt")).toBe("patched\n");
      }
      for (const args of [{}, { path: "." }, { path: workspaceDir }]) {
        expect(text(await rw("ls", args))).toContain("note.txt");
      }
      expect(await readText(workspaceDir, "agent.txt")).toBe("CONTENT_SHADOW");
      const ro = makeTools("ro");
      expect(
        text(
          await ro("read", {
            path: path.join(agentWorkspaceDir, "agent.txt"),
          }),
        ),
      ).toContain("CONTENT_AGENT");
      expect(text(await rw("read", { path: skillRelative }))).toContain("CONTENT_SKILL");
      for (const filePath of [skillRelative, path.join(workspaceDir, skillRelative)]) {
        await expect(rw("write", { path: filePath, content: "DENIED" })).rejects.toThrow(
          /read-only|Path escapes sandbox root/,
        );
        await expect(
          rw("edit", {
            path: filePath,
            edits: [{ oldText: "CONTENT_SKILL", newText: "DENIED" }],
          }),
        ).rejects.toThrow(/read-only|Path escapes sandbox root/);
        await expect(
          rw("apply_patch", {
            input: patch(`*** Add File: ${filePath}.new`, "+DENIED"),
          }),
        ).rejects.toThrow(/read-only|Path escapes sandbox root/);
      }
      if (workspaceOnly) {
        await expect(ro("ls", { path: agentWorkspaceDir })).rejects.toThrow(
          "Path escapes sandbox root",
        );
      }
      const none = makeTools("none");
      await expect(
        none("read", { path: path.join(agentWorkspaceDir, "agent.txt") }),
      ).rejects.toThrow("Path escapes sandbox root");
      for (const name of ["read", "write", "edit", "ls"]) {
        await expect(
          rw(name, {
            path: path.join(root, "outside.txt"),
            content: "DENIED",
            edits: [{ oldText: "CONTENT_OUTSIDE", newText: "DENIED" }],
          }),
        ).rejects.toThrow("Path escapes sandbox root");
      }
      await expect(
        rw("apply_patch", {
          input: patch(`*** Add File: ${path.join(root, "outside-new.txt")}`, "+DENIED"),
        }),
      ).rejects.toThrow("Path escapes sandbox root");
      expect(await readText(root, "outside.txt")).toBe("CONTENT_OUTSIDE");
      expect(await readText(agentWorkspaceDir, "agent.txt")).toBe("CONTENT_AGENT");
      expect(await readText(skillsWorkspaceDir, materializedSkill)).toBe("CONTENT_SKILL");
    },
  );
});
