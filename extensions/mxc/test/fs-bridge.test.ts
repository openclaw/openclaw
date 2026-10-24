import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
import { MxcFsBridge } from "../src/fs-bridge.js";

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
const entry = (name: string, isDirectory = false) => ({ name, isDirectory });
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const readText = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const expectOutside = (result: Promise<unknown>) =>
  expect(result).rejects.toThrow("Path escapes sandbox root");
const edit = (filePath: string, oldText: string, newText: string) => ({
  path: filePath,
  edits: [{ oldText, newText }],
});

function makeSandbox(workspaceDir: string, overrides: Partial<SandboxContext> = {}) {
  return createSandboxTestContext({
    overrides: {
      backendId: "mxc",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess: "rw",
      containerWorkdir: workspaceDir,
      tools: { allow: [], deny: [] },
      ...overrides,
    },
  });
}

function directoryReader(params: Partial<SandboxContext> & { workspaceDir: string }) {
  const bridge = new MxcFsBridge(makeSandbox(params.workspaceDir, params));
  const read = expectDefined(bridge.readDirectory?.bind(bridge), "MXC directory reader");
  return (filePath: string, cwd?: string) => read({ filePath, cwd });
}

test("lists entry names and types relative to the mounted directory", async () => {
  await using workspace = await makeWorkspace();
  const workspaceDir = workspace.root;
  await writeFile(workspaceDir, "readme.md", "readme");
  await writeFile(workspaceDir, "notes/one.txt", "note");
  const list = directoryReader({ workspaceDir });

  await expect(list(".")).resolves.toEqual([entry("notes", true), entry("readme.md")]);
  await expect(list(".", path.join(workspaceDir, "notes"))).resolves.toEqual([entry("one.txt")]);
});

test("lists the protected skill mount instead of its workspace shadow", async () => {
  await using workspace = await makeWorkspace();
  const root = workspace.root;
  const workspaceDir = path.join(root, "sandbox");
  const skillsWorkspaceDir = path.join(root, "materialized");
  const skillPath = path.join(".openclaw", "sandbox-skills", "skills");
  await fs.mkdir(path.join(workspaceDir, skillPath, "shadow"), { recursive: true });
  await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
  const list = directoryReader({ workspaceDir, skillsWorkspaceDir });

  await expect(list(skillPath)).resolves.toEqual([entry("demo", true)]);
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
  const list = directoryReader({ workspaceDir });

  await expect(list("outside-link")).rejects.toThrow("path alias escape blocked");
});

test.each([true, false])("native tool paths (workspaceOnly=%s)", async (workspaceOnly) => {
  await using workspace = await makeWorkspace();
  const root = workspace.root;
  const workspaceDir = path.join(root, "sandbox");
  const agentWorkspaceDir = path.join(root, "agent");
  const skillsWorkspaceDir = path.join(root, "materialized");
  await writeFile(skillsWorkspaceDir, materializedSkill, "skill-data");
  await writeFile(agentWorkspaceDir, "agent.txt", "agent-data");
  await writeFile(workspaceDir, "agent.txt", "shadow-data");
  await writeFile(root, "outside.txt", "outside-data");
  const makeTools = (workspaceAccess: "none" | "ro" | "rw") => {
    const sandbox = makeSandbox(workspaceDir, {
      agentWorkspaceDir,
      skillsWorkspaceDir,
      workspaceAccess,
    });
    sandbox.fsBridge = new MxcFsBridge(sandbox);
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
    return async (name: string, args: unknown) =>
      text(
        await expectDefined(
          tools.find((tool) => tool.name === name),
          `Missing ${name}`,
        ).execute(name, args),
      );
  };
  const text = (result: Awaited<ReturnType<AnyAgentTool["execute"]>>) =>
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  const rw = makeTools("rw");
  for (const filePath of ["note.txt", path.join(workspaceDir, "note.txt")]) {
    await rw("write", { path: filePath, content: "original\n" });
    await rw("edit", edit(filePath, "original", "edited"));
    expect(await rw("read", { path: filePath })).toContain("edited");
    await rw("apply_patch", {
      input: patch(`*** Update File: ${filePath}`, "@@", "-edited", "+patched"),
    });
    expect(await readText(agentWorkspaceDir, "note.txt")).toBe("patched\n");
  }
  for (const args of [{}, { path: "." }, { path: workspaceDir }]) {
    expect(await rw("ls", args)).toContain("note.txt");
  }
  await expectOutside(rw("ls", { path: agentWorkspaceDir }));
  expect(await readText(workspaceDir, "agent.txt")).toBe("shadow-data");
  const ro = makeTools("ro");
  expect(await ro("read", { path: "agent.txt" })).toContain("shadow-data");
  expect(await ro("read", { path: path.join(agentWorkspaceDir, "agent.txt") })).toContain(
    "agent-data",
  );
  expect(await rw("read", { path: skillRelative })).toContain("skill-data");
  const denySkillMutation = (result: ReturnType<typeof rw>) =>
    expect(result).rejects.toThrow(/read-only|Path escapes sandbox root/);
  for (const filePath of [skillRelative, path.join(workspaceDir, skillRelative)]) {
    await denySkillMutation(rw("write", { path: filePath, content: "DENIED" }));
    await denySkillMutation(rw("edit", edit(filePath, "skill-data", "DENIED")));
    await denySkillMutation(
      rw("apply_patch", {
        input: patch(`*** Add File: ${filePath}.new`, "+DENIED"),
      }),
    );
  }
  if (workspaceOnly) {
    await expectOutside(ro("ls", { path: agentWorkspaceDir }));
  } else {
    expect(await ro("ls", { path: agentWorkspaceDir })).toContain("agent.txt");
  }
  const none = makeTools("none");
  expect(await none("read", { path: "agent.txt" })).toContain("shadow-data");
  expect(await none("ls", { path: workspaceDir })).toContain("agent.txt");
  await expectOutside(none("read", { path: path.join(agentWorkspaceDir, "agent.txt") }));
  for (const name of ["read", "write", "edit", "ls"]) {
    await expectOutside(
      rw(name, {
        path: path.join(root, "outside.txt"),
        content: "DENIED",
        edits: [{ oldText: "outside-data", newText: "DENIED" }],
      }),
    );
  }
  await expectOutside(
    rw("apply_patch", {
      input: patch(`*** Add File: ${path.join(root, "outside-new.txt")}`, "+DENIED"),
    }),
  );
  expect(
    await Promise.all([
      readText(root, "outside.txt"),
      readText(agentWorkspaceDir, "agent.txt"),
      readText(skillsWorkspaceDir, materializedSkill),
    ]),
  ).toEqual(["outside-data", "agent-data", "skill-data"]);
});
