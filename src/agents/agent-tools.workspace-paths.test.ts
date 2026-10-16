import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReadTool } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let rootDir: string, workspaceDir: string, outsideDir: string;
beforeEach(async () => {
  rootDir = await fs.realpath(tempDirs.make("openclaw-workspace-paths-"));
  workspaceDir = path.join(rootDir, "workspace");
  outsideDir = path.join(rootDir, "outside");
  await fs.mkdir(workspaceDir);
  await fs.mkdir(outsideDir);
});
vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});
function workspaceTools(
  directory: string,
  options: Parameters<typeof createOpenClawCodingTools>[0] = {},
) {
  return expectReadWriteEditTools(
    createOpenClawCodingTools({
      ...options,
      workspaceDir: directory,
      config: { tools: { fs: { workspaceOnly: true } } },
    }),
  );
}
const readText = async (tool: AnyAgentTool, id: string, filePath: string) =>
  getTextContent(await tool.execute(id, { path: filePath }));
const expectFile = (filePath: string, content: string) =>
  expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
const write = (tool: AnyAgentTool, filePath: string, content: string) =>
  tool.execute("write", { path: filePath, content });
const edit = (tool: AnyAgentTool, filePath: string, oldText: string, newText: string) =>
  tool.execute("edit", { path: filePath, edits: [{ oldText, newText }] });

async function skillWorkspace() {
  const skillDir = path.join(rootDir, "global-skills/demo");
  const skillFile = path.join(skillDir, "SKILL.md");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, "# Demo skill\noriginal skill\n");
  const tools = workspaceTools(workspaceDir, {
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
  return { skillDir, skillFile, ...tools };
}

it("uses cwd for coding filesystem tools while workspaceDir remains the agent workspace", async () => {
  const cwd = tempDirs.make("openclaw-task-cwd-");
  const tools = createOpenClawCodingTools({ workspaceDir, cwd });
  const { readTool, writeTool } = expectReadWriteEditTools(tools);

  await fs.writeFile(path.join(cwd, "task.txt"), "task cwd read ok", "utf8");
  expect(await readText(readTool, "cwd-read", "task.txt")).toContain("task cwd read ok");

  await write(writeTool, "created.txt", "task cwd write ok");
  await expectFile(path.join(cwd, "created.txt"), "task cwd write ok");
  await expect(fs.access(path.join(workspaceDir, "created.txt"))).rejects.toThrow();
});

it.runIf(process.platform === "win32")(
  "preserves mixed-case and Unicode names for workspace-only writes on Windows",
  async () => {
    const { writeTool } = workspaceTools(workspaceDir);

    await write(writeTool, "Source/İstanbul/Widget.ts", "export const Widget = true;");

    await expect(fs.readdir(workspaceDir)).resolves.toEqual(["Source"]);
    await expect(fs.readdir(path.join(workspaceDir, "Source"))).resolves.toEqual(["İstanbul"]);
    await expect(fs.readdir(path.join(workspaceDir, "Source", "İstanbul"))).resolves.toEqual([
      "Widget.ts",
    ]);
  },
);

it("defaults exec cwd to workspaceDir when workdir is omitted", async () => {
  const exec = createOpenClawCodingTools({
    workspaceDir,
    exec: { host: "gateway", ask: "off", security: "full" },
  }).find((tool) => tool.name === "exec");
  if (!exec) {
    throw new Error("expected exec tool");
  }
  const result = await exec.execute("cwd", { command: "echo ok" });
  expect(result.details).toMatchObject({ cwd: await fs.realpath(workspaceDir) });
});

it("rejects @-prefixed absolute paths outside workspace when workspaceOnly is enabled", async () => {
  const { readTool } = workspaceTools(workspaceDir);

  const outsideAbsolute = path.resolve(path.parse(workspaceDir).root, "outside-openclaw.txt");
  await expect(
    readTool.execute("ws-read-at-prefix", { path: `@${outsideAbsolute}` }),
  ).rejects.toThrow(/Path escapes sandbox root/i);
});

it("guards decoded file URLs while forwarding the original URL", async () => {
  const root = workspaceDir;
  const inside = path.join(root, "note.txt");
  const outside = path.join(rootDir, "outside.txt");
  await fs.writeFile(inside, "URL_INSIDE_MARKER");
  await fs.writeFile(outside, "URL_OUTSIDE_MARKER");
  const base = createReadTool(root) as unknown as AnyAgentTool;
  const execute = vi.spyOn(base, "execute");
  const read = wrapToolWorkspaceRootGuardWithOptions(base, root, {
    containerWorkdir: "/workspace",
    normalizeGuardedPathParams: false,
  });
  const insideUrl = pathToFileURL(inside).href;

  expect(await readText(read, "inside-url", insideUrl)).toContain("URL_INSIDE_MARKER");
  expect(execute).toHaveBeenCalledWith("inside-url", { path: insideUrl }, undefined, undefined);
  await expect(read.execute("outside-url", { path: pathToFileURL(outside).href })).rejects.toThrow(
    /Path escapes sandbox root/i,
  );
  expect(execute).toHaveBeenCalledTimes(1);
  await expectFile(inside, "URL_INSIDE_MARKER");
  await expectFile(outside, "URL_OUTSIDE_MARKER");
});

it.runIf(process.platform !== "win32")("rejects hardlinked file aliases", async () => {
  const outside = path.join(rootDir, "outside.txt");
  await fs.writeFile(outside, "top-secret");
  await fs.link(outside, path.join(workspaceDir, "linked.txt"));
  const { readTool, writeTool } = workspaceTools(workspaceDir);
  await expect(readTool.execute("read", { path: "linked.txt" })).rejects.toThrow(
    /hardlink|sandbox/i,
  );
  await expect(write(writeTool, "linked.txt", "pwned")).rejects.toThrow(/hardlink|sandbox/i);
  await expectFile(outside, "top-secret");
});

it.runIf(process.platform !== "win32").each(["write", "edit"] as const)(
  "%s follows in-workspace symlink parents",
  async (operation) => {
    const realDir = path.join(workspaceDir, "real");
    await fs.mkdir(realDir);
    await fs.symlink(realDir, path.join(workspaceDir, "memory"));
    const target = path.join(realDir, "note.md");
    await fs.writeFile(target, "old memory\n");
    const { writeTool, editTool } = workspaceTools(workspaceDir);
    if (operation === "write") {
      await write(writeTool, "memory/note.md", "new memory\n");
    } else {
      await edit(editTool, "memory/note.md", "old", "new");
    }
    await expectFile(target, "new memory\n");
  },
);

it.runIf(process.platform !== "win32").each([
  ["escaping parent", "memory/secret.md", /Path escapes workspace root|outside-workspace|sandbox/i],
  ["final symlink", "memory", /symlink|not-file|directory component/i],
] as const)("rejects workspace-only writes through a %s", async (kind, filePath, error) => {
  const finalLink = kind === "final symlink";
  const target = finalLink ? path.join(workspaceDir, "target.md") : outsideDir;
  if (finalLink) {
    await fs.writeFile(target, "original\n");
  }
  await fs.symlink(target, path.join(workspaceDir, "memory"));
  await expect(write(workspaceTools(workspaceDir).writeTool, filePath, "pwned\n")).rejects.toThrow(
    error,
  );
  if (finalLink) {
    await expectFile(target, "original\n");
  } else {
    await expect(fs.stat(path.join(outsideDir, "secret.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it("allows workspaceOnly reads for resolved skill roots without allowing other filesystem access", async () => {
  const { skillDir, skillFile, readTool, writeTool, editTool } = await skillWorkspace();
  const guideFile = path.join(skillDir, "guide.md");
  const siblingFile = path.join(rootDir, "global-skills/other/SKILL.md");
  const outsideFile = path.join(rootDir, "outside.txt");
  await fs.mkdir(path.dirname(siblingFile));
  await fs.writeFile(guideFile, "skill guide");
  await fs.writeFile(siblingFile, "sibling skill");
  await fs.writeFile(outsideFile, "outside secret");

  expect(await readText(readTool, "read-skill", skillFile)).toContain("original skill");
  expect(await readText(readTool, "read-skill-guide", guideFile)).toContain("skill guide");
  await expect(readTool.execute("read-sibling", { path: siblingFile })).rejects.toThrow(
    /Path escapes sandbox root/i,
  );
  await expect(readTool.execute("read-outside", { path: outsideFile })).rejects.toThrow(
    /Path escapes sandbox root/i,
  );
  await expect(write(writeTool, skillFile, "overwritten")).rejects.toThrow(
    /Path escapes sandbox root|outside-workspace/i,
  );
  await expect(edit(editTool, skillFile, "original", "edited")).rejects.toThrow(
    /Path escapes sandbox root|outside-workspace/i,
  );
  expect(await fs.readFile(skillFile, "utf8")).toContain("original skill");
});

it("rejects symlink escapes inside resolved skill roots", async () => {
  if (process.platform === "win32") {
    return;
  }
  const { skillDir, readTool } = await skillWorkspace();
  const outsideFile = path.join(rootDir, "outside.txt");
  const linkPath = path.join(skillDir, "outside-link.txt");
  await fs.writeFile(outsideFile, "outside secret");
  await fs.symlink(outsideFile, linkPath);

  await expect(readTool.execute("read-skill-symlink", { path: linkPath })).rejects.toThrow(
    /symlink|sandbox|outside|escape/i,
  );
});
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
    const { readTool } = workspaceTools(sandboxRoot, { sandbox });

    expect(await readText(readTool, "legacy-inside-url", pathToFileURL(inside).href)).toContain(
      "LEGACY_URL_INSIDE_MARKER",
    );
    const readsBefore = readFile.mock.calls.length;
    const statsBefore = stat.mock.calls.length;
    expect(readsBefore).toBeGreaterThan(0);
    expect(statsBefore).toBeGreaterThan(0);
    await expect(
      readTool.execute("legacy-outside-url", { path: pathToFileURL(outside).href }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    expect(readFile).toHaveBeenCalledTimes(readsBefore);
    expect(stat).toHaveBeenCalledTimes(statsBefore);
    await expectFile(inside, "LEGACY_URL_INSIDE_MARKER");
    await expectFile(outside, "LEGACY_URL_OUTSIDE_MARKER");
  });
});

it("uses sandbox workspace for relative read/write/edit", async () => {
  const sandboxDir = tempDirs.make("openclaw-sandbox-");
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

  expect(await readText(readTool, "sbx-read", testFile)).toContain("sandbox read");

  await write(writeTool, "new.txt", "sandbox write");
  await expectFile(path.join(sandboxDir, "new.txt"), "sandbox write");

  await edit(editTool, "new.txt", "write", "edit");
  await expectFile(path.join(sandboxDir, "new.txt"), "sandbox edit");
});

const APPLY_PATCH_PAYLOAD =
  "*** Begin Patch\n*** Add File: /agent/pwned.txt\n+owned-by-apply-patch\n*** End Patch";

it("defaults to allowing sandbox mounts outside the workspace root", async () => {
  await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
    await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh");
    const { readTool, writeTool } = expectReadWriteTools(
      createOpenClawCodingTools({
        workspaceDir: sandbox.workspaceDir,
        sandbox,
      }),
    );
    expect(await readText(readTool, "read", "/agent/secret.txt")).toContain("shh");
    await write(writeTool, "/agent/owned.txt", "x");
    await expectFile(path.join(agentRoot, "owned.txt"), "x");
  });
});

it("allows read-only materialized sandbox skills for sandbox reads only", async () => {
  await withUnsafeMountedSandboxHarness(
    async ({ sandbox, skillsWorkspaceDir }) => {
      expect(skillsWorkspaceDir).toBeTruthy();
      const skillPath = ".openclaw/sandbox-skills/skills/demo/SKILL.md";
      const skillFile = path.join(skillsWorkspaceDir!, "skills/demo/SKILL.md");
      const shadowFile = path.join(sandbox.workspaceDir, skillPath);
      for (const file of [skillFile, shadowFile]) {
        await fs.mkdir(path.dirname(file), { recursive: true });
      }
      await fs.writeFile(skillFile, "# Demo\nmaterialized\n");
      await fs.writeFile(shadowFile, "# Demo\nuser-owned shadow\n");

      const { readTool } = workspaceTools(sandbox.workspaceDir, { sandbox });
      for (const filePath of [
        `/workspace/${skillPath}`,
        skillPath,
        `file:///workspace/${skillPath}`,
      ]) {
        const text = await readText(readTool, "skill", filePath);
        expect(text).toContain("materialized");
        expect(text).not.toContain("user-owned shadow");
      }
      expect(await fs.readFile(skillFile, "utf8")).toContain("materialized");
      expect(await fs.readFile(shadowFile, "utf8")).toContain("user-owned shadow");
    },
    { includeSkillsWorkspace: true, workspaceAccess: "rw" },
  );
});

it("enforces apply_patch workspace-only in sandbox mounts by default", async () => {
  await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
    const { workspaceDir: root, containerWorkdir: containerRoot, fsBridge } = sandbox;
    const applyPatchTool = createApplyPatchTool({
      cwd: root,
      sandbox: { root, bridge: fsBridge!, workspaceMounts: [{ hostRoot: root, containerRoot }] },
    });

    await expect(applyPatchTool.execute("t1", { input: APPLY_PATCH_PAYLOAD })).rejects.toThrow(
      /Path escapes sandbox root/i,
    );
    await expect(fs.stat(path.join(agentRoot, "pwned.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
