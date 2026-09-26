import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { readSkillResourceFiles } from "../../skills/runtime/resources.js";
import { readSkillCompanionAtSource } from "../../skills/runtime/skill-companion.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import type { SkillEntry } from "../../skills/types.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { readCodeModeSkill } from "../code-mode-skills.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness, pluginTool, runUntilCompleted } from "../code-mode.test-support.js";
import { createCoreCodingTools } from "../core-coding-tools.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
import { registerAgentWorkspaceAccess } from "../workspace-access.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

const libraryFixture = vi.hoisted(() => ({ entries: [] as SkillEntry[] }));
vi.mock("../../skills/library/selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/library/selection.js")>();
  const selectedEntries = (selections: readonly unknown[]) =>
    selections.length > 0 ? libraryFixture.entries : [];
  return {
    ...actual,
    loadSkillLibrarySelection: selectedEntries,
    prepareSkillLibrarySelection: async (selections: readonly unknown[]) =>
      selectedEntries(selections),
  };
});

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  libraryFixture.entries = [];
  vi.unstubAllEnvs();
});

it.each([false, true])("Code Mode file ownership (same-name pin: %s)", async (collision) => {
  const root = temps.make("code-mode-workspace-");
  const bundled = path.join(root, "bundled");
  await fs.mkdir(bundled);
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  const gateway = path.join(root, "gateway");
  const host = path.join(root, "host");
  const library = path.join(root, "library");
  const relative = "skills/guide/SKILL.md";
  const header = "---\nname: guide\ndescription: Test guide\n---\n";
  for (const [dir, body] of [
    [gateway, "stale Gateway body"],
    [host, "current host body"],
  ] as const) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), header + body);
    await fs.mkdir(path.join(dir, "skills/guide/refs"));
    await fs.writeFile(path.join(dir, "skills/guide/refs/support.txt"), `${body} support`);
  }
  await fs.mkdir(path.join(library, "skills/pinned"), { recursive: true });
  const libraryBody = "---\nname: pinned\ndescription: Pinned guide\n---\nGateway Library body";
  await fs.writeFile(path.join(library, "skills/pinned/SKILL.md"), libraryBody);
  if (collision) {
    await writeSkill({
      dir: path.join(library, "skills/guide"),
      name: "guide",
      description: "Unavailable Library guide",
      metadata: JSON.stringify({ openclaw: { os: ["unsupported-test-platform"] } }),
    });
  }
  // Resolve the fixture pin without a Library database; instruction reads still use real files.
  libraryFixture.entries = loadWorkspaceSkills(library, { workspaceOnly: true });
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: { agentDir: path.join(root, "agent") } } },
  };
  const workshopDir = path.join(resolveWorkshopSkillsDir(config, "main"), "workshop");
  await writeSkill({
    dir: workshopDir,
    name: "workshop",
    description: "Workshop guide",
    body: "Workshop body",
  });
  const readFile = vi.fn(async () => {
    throw new Error("Agent-document access does not grant Skill reads");
  });
  const readInstructions = vi.fn((filePath: string, options: { signal?: AbortSignal }) => {
    if (!filePath.startsWith(gateway + path.sep)) {
      throw new Error("The host cannot read Gateway Library files");
    }
    return fs.readFile(path.join(host, path.relative(gateway, filePath)), {
      encoding: "utf8",
      signal: options.signal,
    });
  });
  const readCompanion = vi.fn(
    (
      skillFilePath: string,
      relativePath: string,
      sourceRootIdentity: Parameters<typeof readSkillCompanionAtSource>[0]["sourceRootIdentity"],
      options: { signal?: AbortSignal },
    ) =>
      readSkillCompanionAtSource({
        skillFilePath: path.join(host, path.relative(gateway, skillFilePath)),
        relativePath,
        sourceRootIdentity,
        signal: options.signal,
      }),
  );
  const skillResources = {
    resolveExplicitSkill: vi.fn(),
    readSkillFiles: vi.fn(),
    readInstructions,
    readCompanion,
  };
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
    skillResources,
    loadSkills: async () => ({
      entries: loadWorkspaceSkills(host, { workspaceOnly: true }).map((entry) => {
        entry.skill.filePath = path.join(gateway, path.relative(host, entry.skill.filePath));
        entry.skill.baseDir = path.join(gateway, path.relative(host, entry.skill.baseDir));
        return entry;
      }),
      executionEntries: [],
      runtime: { platform: process.platform, bins: [] },
    }),
  });
  try {
    const librarySelections = [
      { skillId: "pin", revision: "a".repeat(64), name: "pinned", ownerProfileId: null },
      ...(collision
        ? [
            {
              skillId: "collision",
              revision: "b".repeat(64),
              name: "guide",
              ownerProfileId: null,
            },
          ]
        : []),
    ];
    const snapshot = await buildSkillSnapshot(gateway, {
      config,
      agentId: "main",
      librarySelections,
    });
    snapshot.librarySelections = librarySelections;
    expect(snapshot.resolvedSkills?.find((skill) => skill.name === "guide")?.fileHost).toBe(
      "workspace",
    );
    expect(snapshot.prompt).toContain("<location>~/");
    const prepared = await prepareEmbeddedSkills({
      attempt: { config: {}, skillsSnapshot: snapshot },
      effectiveWorkspace: gateway,
      sandbox: undefined,
      sessionAgentId: "main",
      includeCodeModeSkills: true,
      applySkillEnvironment: false,
    });
    expect(prepared.codeModeSkills).toHaveLength(3);
    const skill = prepared.codeModeSkills.find((entry) => entry.name === "guide")!;
    expect(await readCodeModeSkill(skill)).toBe(header + "current host body");
    await expect(readCodeModeSkill(skill, undefined, "refs/support.txt")).resolves.toBe(
      "current host body support",
    );
    expect(readCompanion).toHaveBeenLastCalledWith(
      path.join(gateway, "skills/guide/SKILL.md"),
      "refs/support.txt",
      expect.objectContaining({
        realPath: path.join(host, "skills/guide"),
        dev: expect.any(String),
        ino: expect.any(String),
      }),
      { signal: undefined },
    );
    await fs.writeFile(path.join(host, relative), header + "edited host body");
    expect(await readCodeModeSkill(skill)).toBe(header + "edited host body");
    const pinned = prepared.codeModeSkills.find((entry) => entry.name === "pinned")!;
    expect(await readCodeModeSkill(pinned)).toBe(libraryBody);
    const workshop = prepared.codeModeSkills.find((entry) => entry.name === "workshop")!;
    expect(await readCodeModeSkill(workshop)).toContain("Workshop body");
    await fs.appendFile(path.join(workshopDir, "SKILL.md"), "\nWorkshop edit");
    expect(await readCodeModeSkill(workshop)).toContain("Workshop edit");
    expect(readFile).not.toHaveBeenCalled();
    release();
    await expect(readCodeModeSkill(skill)).rejects.toThrow("Workspace access is stopped");
    await expect(readCodeModeSkill(skill, undefined, "refs/support.txt")).rejects.toThrow(
      "Workspace access is stopped",
    );
  } finally {
    release();
  }
});

it("fails closed when a workspace provider lacks companion reads", async () => {
  const root = temps.make("code-mode-companion-unavailable-");
  const gateway = path.join(root, "gateway");
  const host = path.join(root, "host");
  for (const [dir, body] of [
    [gateway, "Gateway decoy"],
    [host, "Workspace host"],
  ] as const) {
    await writeSkill({
      dir: path.join(dir, "skills/guide"),
      name: "guide",
      description: "Test guide",
      body,
    });
    await fs.mkdir(path.join(dir, "skills/guide/refs"));
    await fs.writeFile(path.join(dir, "skills/guide/refs/support.txt"), `${body} support`);
  }
  const readInstructions = vi.fn((filePath: string, options: { signal?: AbortSignal }) =>
    fs.readFile(path.join(host, path.relative(gateway, filePath)), {
      encoding: "utf8",
      signal: options.signal,
    }),
  );
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    skillResources: {
      readInstructions,
      resolveExplicitSkill: vi.fn(),
      readSkillFiles: vi.fn(),
    },
    loadSkills: async () => ({
      entries: loadWorkspaceSkills(host, { workspaceOnly: true }).map((entry) => {
        entry.skill.filePath = path.join(gateway, path.relative(host, entry.skill.filePath));
        entry.skill.baseDir = path.join(gateway, path.relative(host, entry.skill.baseDir));
        return entry;
      }),
      executionEntries: [],
      runtime: { platform: process.platform, bins: [] },
    }),
  });
  try {
    const snapshot = await buildSkillSnapshot(gateway, {
      config: {
        plugins: { enabled: false },
        agents: { entries: { main: { agentDir: path.join(root, "agent") } } },
      },
      agentId: "main",
    });
    const prepared = await prepareEmbeddedSkills({
      attempt: { config: {}, skillsSnapshot: snapshot },
      effectiveWorkspace: gateway,
      sandbox: undefined,
      sessionAgentId: "main",
      includeCodeModeSkills: true,
      applySkillEnvironment: false,
    });
    const skill = prepared.codeModeSkills.find((entry) => entry.name === "guide")!;
    expect(await readCodeModeSkill(skill)).toContain("Workspace host");

    const { config, catalogRef, tools } = createCodeModeHarness({
      codeModeSkills: prepared.codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills: prepared.codeModeSkills,
    });
    const details = await runUntilCompleted({
      execTool: tools[0]!,
      waitTool: tools[1]!,
      code: `
        try {
          return await skills.read("guide", "refs/support.txt");
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      `,
    });
    expect(details).toMatchObject({ status: "completed" });
    expect(details.value).toBe(
      'workspace skill companion reads are unavailable: "refs/support.txt"',
    );
    expect(details.value).not.toContain("Gateway decoy");
    expect(readInstructions).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});

it.each([false, true])(
  "preserves local Code Mode instruction reads for document-only adapters (stopped=%s)",
  async (stopped) => {
    const workspace = temps.make("code-mode-document-only-");
    await writeSkill({
      dir: path.join(workspace, "skills", "guide"),
      name: "guide",
      description: "Local guide",
      body: "Local instructions",
    });
    const snapshot = await buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    });
    const readFile = vi.fn();
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
    });
    if (stopped) {
      release();
    }
    try {
      const prepared = await prepareEmbeddedSkills({
        attempt: { config: {}, skillsSnapshot: snapshot },
        effectiveWorkspace: workspace,
        sandbox: undefined,
        sessionAgentId: "main",
        includeCodeModeSkills: true,
        applySkillEnvironment: false,
      });
      const skill = prepared.codeModeSkills.find((entry) => entry.name === "guide")!;
      expect(await readCodeModeSkill(skill)).toContain("Local instructions");
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it.each([
  ["SKILL.md", true],
  ["refs/support.txt", true],
  ["SKILL.md", false],
  ["refs/support.txt", false],
] as const)(
  "ordinary read uses the selected workspace host for %s (workspaceOnly=%s)",
  async (fileName, workspaceOnly) => {
    const root = temps.make("ordinary-remote-skill-");
    const workspace = path.join(root, "workspace");
    const logical = path.join(root, "gateway-decoy");
    const host = path.join(root, "host");
    const library = path.join(root, "library");
    await fs.mkdir(workspace);
    for (const [dir, body] of [
      [logical, "Gateway decoy"],
      [host, "Host instructions"],
      [library, "Gateway Library instructions"],
    ] as const) {
      await writeSkill({
        dir: path.join(dir, "skills/guide"),
        name: "guide",
        description: "Guide",
        body,
      });
      await fs.mkdir(path.join(dir, "skills/guide/refs"));
      await fs.writeFile(path.join(dir, "skills/guide/refs/support.txt"), body + " support");
    }
    await fs.writeFile(path.join(workspace, "local.txt"), "Local project file");
    await fs.writeFile(path.join(root, "outside.txt"), "Not admitted");
    const selectedAtHost = loadWorkspaceSkills(host, { workspaceOnly: true })[0]!.skill;
    const selected = {
      ...selectedAtHost,
      filePath: path.join(logical, path.relative(host, selectedAtHost.filePath)),
      baseDir: path.join(logical, path.relative(host, selectedAtHost.baseDir)),
    };
    const gatewaySkill = loadWorkspaceSkills(library, { workspaceOnly: true })[0]!.skill;
    const skill = { ...selected, fileHost: "workspace" as const };
    const resources = {
      readInstructions: (filePath: string, options: { signal?: AbortSignal }) =>
        fs.readFile(path.join(host, path.relative(logical, filePath)), {
          encoding: "utf8",
          signal: options.signal,
        }),
      readCompanion: (
        skillFilePath: string,
        relativePath: string,
        sourceRootIdentity: Parameters<typeof readSkillCompanionAtSource>[0]["sourceRootIdentity"],
        options: { signal?: AbortSignal },
      ) =>
        readSkillCompanionAtSource({
          skillFilePath: path.join(host, path.relative(logical, skillFilePath)),
          relativePath,
          sourceRootIdentity,
          signal: options.signal,
        }),
      resolveExplicitSkill: vi.fn(),
      readSkillFiles: (
        entry: Parameters<typeof readSkillResourceFiles>[0],
        options: { allowMissingRoot: boolean },
      ) =>
        readSkillResourceFiles(
          {
            ...entry,
            baseDir: path.join(host, "skills/guide"),
            filePath: path.join(host, "skills/guide/SKILL.md"),
          },
          options,
        ),
    };
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
      loadSkills: vi.fn(),
      skillResources: resources,
    });
    try {
      const read = createCoreCodingTools({
        codingRoot: workspace,
        containmentRoot: workspace,
        includeBaseCodingTools: true,
        shellTools: "disabled",
        workspaceOnly,
        readOnly: true,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
        skillsSnapshot: {
          skills: [],
          prompt: "",
          resolvedSkills: [skill, { ...gatewaySkill, fileHost: "gateway" }],
        },
      }).find((tool) => tool.name === "read")!;
      const target = path.join(skill.baseDir, fileName);
      expect(
        getTextContent(
          await read.execute("remote", {
            path: target,
            ...(fileName === "SKILL.md" ? { offset: 2, limit: 1 } : {}),
          }),
        ),
      ).toContain(fileName === "SKILL.md" ? "Host instructions" : "Host instructions support");
      expect(
        getTextContent(await read.execute("library", { path: gatewaySkill.filePath })),
      ).toContain("Gateway Library instructions");
      expect(getTextContent(await read.execute("local", { path: "local.txt" }))).toContain(
        "Local project file",
      );
      if (workspaceOnly) {
        await expect(
          read.execute("outside", { path: path.join(root, "outside.txt") }),
        ).rejects.toThrow();
        await expect(
          read.execute("escape", { path: path.join(skill.baseDir, "../../../outside.txt") }),
        ).rejects.toThrow();
      }
      release();
      await expect(read.execute("stopped", { path: target })).rejects.toThrow(
        "stopped or not ready",
      );
    } finally {
      release();
    }
  },
);
