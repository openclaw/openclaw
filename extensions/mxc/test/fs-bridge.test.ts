import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, test } from "vitest";
import { createMxcFsBridge } from "../src/fs-bridge.js";

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
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-directory-",
    });
    const workspaceDir = await fs.realpath(workspace.dir);
    await fs.mkdir(path.join(workspaceDir, "notes"));
    await fs.writeFile(path.join(workspaceDir, "readme.md"), "readme");
    await fs.writeFile(path.join(workspaceDir, "notes", "one.txt"), "note");
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
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-mounts-",
    });
    const root = await fs.realpath(workspace.dir);
    const workspaceDir = path.join(root, "sandbox");
    const agentWorkspaceDir = path.join(root, "agent");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(agentWorkspaceDir);
    await fs.writeFile(path.join(workspaceDir, "sandbox.txt"), "sandbox");
    await fs.writeFile(path.join(agentWorkspaceDir, "agent.txt"), "agent");
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
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-skills-",
    });
    const root = await fs.realpath(workspace.dir);
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
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-symlink-",
    });
    const root = await fs.realpath(workspace.dir);
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
      await using workspace = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-mxc-tools-",
      });
      const root = await fs.realpath(workspace.dir);
      const workspaceDir = path.join(root, "sandbox");
      const agentWorkspaceDir = path.join(root, "agent");
      const skillsWorkspaceDir = path.join(root, "materialized");
      for (const dir of [workspaceDir, agentWorkspaceDir]) {
        await fs.mkdir(dir);
      }
      const skillRelative = path.join(".openclaw", "sandbox-skills", "skills", "demo", "SKILL.md");
      await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
      await fs.writeFile(
        path.join(skillsWorkspaceDir, "skills", "demo", "SKILL.md"),
        "MATERIALIZED_SKILL_MARKER",
      );
      await fs.writeFile(path.join(agentWorkspaceDir, "agent.txt"), "AGENT_READ_MARKER");
      await fs.writeFile(path.join(workspaceDir, "agent.txt"), "WORKSPACE_SHADOW_MARKER");
      await fs.writeFile(path.join(root, "outside.txt"), "OUTSIDE_MARKER");
      const makeTools = (workspaceAccess: "none" | "ro" | "rw") => {
        const sandbox: SandboxContext = {
          enabled: true,
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
          browserAllowHostControl: false,
          docker: {
            image: "unused",
            containerPrefix: "unused",
            workdir: workspaceDir,
            readOnlyRoot: true,
            tmpfs: [],
            network: "none",
            capDrop: [],
            env: {},
          },
          tools: { allow: [], deny: [] },
        };
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
        return (name: string) =>
          expectDefined(
            tools.find((tool) => tool.name === name),
            `Missing ${name}`,
          );
      };
      const text = (result: Awaited<ReturnType<AnyAgentTool["execute"]>>) =>
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      const rw = makeTools("rw");
      for (const filePath of ["note.txt", path.join(workspaceDir, "note.txt")]) {
        await rw("write").execute("write", { path: filePath, content: "ORIGINAL_MARKER\n" });
        await rw("edit").execute("edit", {
          path: filePath,
          edits: [{ oldText: "ORIGINAL_MARKER", newText: "EDITED_MARKER" }],
        });
        expect(text(await rw("read").execute("read", { path: filePath }))).toContain(
          "EDITED_MARKER",
        );
        await rw("apply_patch").execute("patch", {
          input: [
            "*** Begin Patch",
            `*** Update File: ${filePath}`,
            "@@",
            "-EDITED_MARKER",
            "+PATCHED_MARKER",
            "*** End Patch",
          ].join("\n"),
        });
        expect(await fs.readFile(path.join(agentWorkspaceDir, "note.txt"), "utf8")).toBe(
          "PATCHED_MARKER\n",
        );
      }
      for (const args of [{}, { path: "." }, { path: workspaceDir }]) {
        expect(text(await rw("ls").execute("ls", args))).toContain("note.txt");
      }
      expect(await fs.readFile(path.join(workspaceDir, "agent.txt"), "utf8")).toBe(
        "WORKSPACE_SHADOW_MARKER",
      );
      const ro = makeTools("ro");
      expect(
        text(
          await ro("read").execute("read-agent", {
            path: path.join(agentWorkspaceDir, "agent.txt"),
          }),
        ),
      ).toContain("AGENT_READ_MARKER");
      expect(text(await rw("read").execute("read-skill", { path: skillRelative }))).toContain(
        "MATERIALIZED_SKILL_MARKER",
      );
      for (const filePath of [skillRelative, path.join(workspaceDir, skillRelative)]) {
        await expect(
          rw("write").execute("deny-write", { path: filePath, content: "DENIED" }),
        ).rejects.toThrow(/read-only|Path escapes sandbox root/);
        await expect(
          rw("edit").execute("deny-edit", {
            path: filePath,
            edits: [{ oldText: "MARKER", newText: "DENIED" }],
          }),
        ).rejects.toThrow(/read-only|Path escapes sandbox root/);
        await expect(
          rw("apply_patch").execute("deny-patch", {
            input: [
              "*** Begin Patch",
              `*** Add File: ${filePath}.new`,
              "+DENIED",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow(/read-only|Path escapes sandbox root/);
      }
      if (workspaceOnly) {
        await expect(ro("ls").execute("deny-list", { path: agentWorkspaceDir })).rejects.toThrow(
          "Path escapes sandbox root",
        );
      }
      const none = makeTools("none");
      await expect(
        none("read").execute("deny-agent", { path: path.join(agentWorkspaceDir, "agent.txt") }),
      ).rejects.toThrow("Path escapes sandbox root");
      for (const name of ["read", "write", "edit", "ls"]) {
        await expect(
          rw(name).execute("deny-outside", {
            path: path.join(root, "outside.txt"),
            content: "DENIED",
            edits: [{ oldText: "OUTSIDE_MARKER", newText: "DENIED" }],
          }),
        ).rejects.toThrow("Path escapes sandbox root");
      }
      await expect(
        rw("apply_patch").execute("deny-outside-patch", {
          input: [
            "*** Begin Patch",
            `*** Add File: ${path.join(root, "outside-new.txt")}`,
            "+DENIED",
            "*** End Patch",
          ].join("\n"),
        }),
      ).rejects.toThrow("Path escapes sandbox root");
      expect(await fs.readFile(path.join(root, "outside.txt"), "utf8")).toBe("OUTSIDE_MARKER");
      expect(await fs.readFile(path.join(agentWorkspaceDir, "agent.txt"), "utf8")).toBe(
        "AGENT_READ_MARKER",
      );
      expect(
        await fs.readFile(path.join(skillsWorkspaceDir, "skills", "demo", "SKILL.md"), "utf8"),
      ).toBe("MATERIALIZED_SKILL_MARKER");
    },
  );
});
