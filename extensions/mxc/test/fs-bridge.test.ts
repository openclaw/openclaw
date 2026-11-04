import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
import { MxcFsBridge } from "../src/fs-bridge.js";

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
const text = (result: Awaited<ReturnType<AnyAgentTool["execute"]>>) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
type RunTool = (name: string, args: unknown) => Promise<string>;
async function denyMutations(run: RunTool, file: string, oldText: string, error: string | RegExp) {
  for (const [name, args] of [
    ["write", { path: file, content: "DENIED" }],
    ["edit", edit(file, oldText, "DENIED")],
    ["apply_patch", { input: patch(`*** Add File: ${file}.new`, "+DENIED") }],
  ] as const) {
    await expect(run(name, args)).rejects.toThrow(error);
  }
}

test.each([true, false])("native tool paths (workspaceOnly=%s)", async (workspaceOnly) => {
  await using workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-mxc-",
  });
  const root = await fs.realpath(workspace.dir);
  const workspaceDir = path.join(root, "sandbox");
  const agentWorkspaceDir = path.join(root, "agent");
  const skillsWorkspaceDir = path.join(root, "materialized");
  await writeFile(skillsWorkspaceDir, materializedSkill, "skill-data");
  await writeFile(agentWorkspaceDir, "agent.txt", "agent-data");
  await writeFile(workspaceDir, "agent.txt", "shadow-data");
  await writeFile(root, "outside.txt", "outside-data");
  const makeTools = (workspaceAccess: "none" | "ro" | "rw") => {
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "mxc",
        workspaceDir,
        agentWorkspaceDir,
        skillsWorkspaceDir,
        workspaceAccess,
        containerWorkdir: workspaceDir,
        tools: { allow: [], deny: [] },
      },
    });
    const bridge = new MxcFsBridge(sandbox);
    sandbox.fsBridge = bridge;
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
    const run = async (name: string, args: unknown) => {
      const selected = tools.find((tool) => tool.name === name);
      return text(await expectDefined(selected, `Missing ${name}`).execute(name, args));
    };
    return Object.assign(run, { bridge });
  };
  const rw = makeTools("rw");
  const list = (filePath: string, cwd?: string) => rw.bridge.readDirectory({ filePath, cwd });
  await writeFile(agentWorkspaceDir, "notes/one.txt", "note");
  await expect(list(".")).resolves.toEqual([entry("agent.txt"), entry("notes", true)]);
  await expect(list(".", path.join(workspaceDir, "notes"))).resolves.toEqual([entry("one.txt")]);
  const skillPath = path.dirname(path.dirname(skillRelative));
  await fs.mkdir(path.join(workspaceDir, skillPath, "shadow"), { recursive: true });
  await expect(list(skillPath)).resolves.toEqual([entry("demo", true)]);
  await fs.symlink(
    root,
    path.join(agentWorkspaceDir, "outside-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(list("outside-link")).rejects.toThrow("path alias escape blocked");
  await fs.unlink(path.join(agentWorkspaceDir, "outside-link"));
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
  const ro = makeTools("ro");
  expect(await ro("read", { path: "agent.txt" })).toContain("shadow-data");
  expect(await ro("read", { path: path.join(agentWorkspaceDir, "agent.txt") })).toContain(
    "agent-data",
  );
  expect(await rw("read", { path: skillRelative })).toContain("skill-data");
  for (const filePath of [skillRelative, path.join(workspaceDir, skillRelative)]) {
    await denyMutations(rw, filePath, "skill-data", /read-only|Path escapes sandbox root/);
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
  const outside = path.join(root, "outside.txt");
  for (const name of ["read", "ls"]) {
    await expectOutside(rw(name, { path: outside }));
  }
  await denyMutations(rw, outside, "outside-data", "Path escapes sandbox root");
  expect(await readText(workspaceDir, "agent.txt")).toBe("shadow-data");
  expect(await readText(root, "outside.txt")).toBe("outside-data");
  expect(await readText(agentWorkspaceDir, "agent.txt")).toBe("agent-data");
  expect(await readText(skillsWorkspaceDir, materializedSkill)).toBe("skill-data");
});
