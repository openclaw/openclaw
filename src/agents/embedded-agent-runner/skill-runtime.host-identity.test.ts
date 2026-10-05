import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { bumpSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import {
  materializeSkillResources,
  prepareSkillResourceDelivery,
  readSkillResourceFiles,
} from "../../skills/runtime/resources.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import { recordSkillFileHost } from "../../skills/skill-file-host.js";
import { resolveWorkspaceSkillSourcePath } from "../../skills/workspace-skill-read-path.js";
import { createOpenClawCodingToolsInternal } from "../agent-tools.js";
import { readCodeModeSkill } from "../code-mode-skills.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
import { registerAgentWorkspaceAccess } from "../workspace-access.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function requireNamedSkill<T extends { name: string }>(skills: T[], name: string): T {
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`missing fixture skill: ${name}`);
  }
  return skill;
}

it("resolves workspace Skill resources with the source host path syntax", () => {
  const filePath = String.raw`C:\agent\skills\guide\SKILL.md`;
  const baseDir = String.raw`C:\agent\skills\guide`;
  const skill = recordSkillFileHost(
    {
      name: "node-guide",
      description: "fixture",
      filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "fixture", baseDir }),
      disableModelInvocation: false,
      source: "fixture",
    },
    "workspace",
  );
  expect(
    resolveWorkspaceSkillSourcePath(
      skill,
      "workspace-skill://workspace/node-guide/references/setup.md",
    ),
  ).toBe(String.raw`C:\agent\skills\guide\references\setup.md`);
});

it("isolates equal-root opposite-host caches through final delivered bytes", async () => {
  const root = temps.make("skill-cache-host-identity-");
  const workspace = path.join(root, "agent");
  const executionRoot = path.join(root, "project");
  const remoteRoot = path.join(root, "remote-project");
  const bundled = path.join(root, "bundled");
  await Promise.all([workspace, bundled].map((dir) => fs.mkdir(dir, { recursive: true })));
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  const write = async (baseDir: string, instructions: string, resource: string) => {
    const skillDir = path.join(baseDir, "skills/guide");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: guide", "description: fixture", "---", instructions].join("\n"),
    );
    await fs.writeFile(path.join(skillDir, "resource.txt"), resource);
  };
  await write(executionRoot, "Gateway instructions", "Gateway resource");
  await write(remoteRoot, "Workspace instructions", "Workspace resource");
  const toRemote = (filePath: string) =>
    path.join(remoteRoot, path.relative(executionRoot, filePath));
  const loadRemoteExecutionEntries = () => {
    const entries = loadWorkspaceSkills(remoteRoot, { workspaceOnly: true });
    for (const entry of entries) {
      entry.skill = {
        ...entry.skill,
        filePath: path.join(executionRoot, path.relative(remoteRoot, entry.skill.filePath)),
        baseDir: path.join(executionRoot, path.relative(remoteRoot, entry.skill.baseDir)),
      };
    }
    return entries;
  };
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: async () => ({
      entries: [],
      executionEntries: loadRemoteExecutionEntries(),
      runtime: { platform: process.platform, bins: [] },
    }),
    skillResources: {
      readInstructions: (filePath, options) =>
        fs.readFile(toRemote(filePath), { ...options, encoding: "utf8" }),
      resolveExplicitSkill: vi.fn(),
      readSkillFiles: (skill, options) =>
        readSkillResourceFiles(
          { ...skill, filePath: toRemote(skill.filePath), baseDir: toRemote(skill.baseDir) },
          options,
        ),
    },
  });
  const config = { plugins: { enabled: false }, skills: { load: { watch: false } } };
  const params = {
    workspaceDir: workspace,
    executionWorkspaceDir: executionRoot,
    config,
    watch: false,
  };
  const readDelivered = async (
    snapshot: Awaited<ReturnType<typeof resolveReusableWorkspaceSkillSnapshot>>["snapshot"],
  ) => {
    const delivery = await prepareSkillResourceDelivery(snapshot, () => {}, [], workspace);
    if (!delivery) {
      throw new Error("missing skill delivery fixture");
    }
    const materialized = await materializeSkillResources(delivery, () => {});
    try {
      const skill = materialized.snapshot.resolvedSkills?.[0];
      if (!skill) {
        throw new Error("missing materialized skill fixture");
      }
      return {
        instructions: await fs.readFile(skill.filePath, "utf8"),
        resource: await fs.readFile(path.join(skill.baseDir, "resource.txt"), "utf8"),
      };
    } finally {
      await materialized.cleanup();
    }
  };
  try {
    const workspaceFirst = await resolveReusableWorkspaceSkillSnapshot(params);
    const workspaceAgain = await resolveReusableWorkspaceSkillSnapshot(params);
    const gatewayAfter = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      executionWorkspaceFileHost: "gateway",
    });
    expect(workspaceAgain.snapshot).toBe(workspaceFirst.snapshot);
    expect(await readDelivered(workspaceAgain.snapshot)).toEqual({
      instructions: expect.stringContaining("Workspace instructions"),
      resource: "Workspace resource",
    });
    expect(await readDelivered(gatewayAfter.snapshot)).toEqual({
      instructions: expect.stringContaining("Gateway instructions"),
      resource: "Gateway resource",
    });

    bumpSkillsSnapshotVersion({ workspaceDir: workspace, reason: "remote-node" });
    const [workspaceConcurrent, gatewayConcurrent] = await Promise.all([
      resolveReusableWorkspaceSkillSnapshot(params),
      resolveReusableWorkspaceSkillSnapshot({
        ...params,
        executionWorkspaceFileHost: "gateway",
      }),
    ]);
    expect(await readDelivered(workspaceConcurrent.snapshot)).toEqual({
      instructions: expect.stringContaining("Workspace instructions"),
      resource: "Workspace resource",
    });
    expect(await readDelivered(gatewayConcurrent.snapshot)).toEqual({
      instructions: expect.stringContaining("Gateway instructions"),
      resource: "Gateway resource",
    });
  } finally {
    release();
  }
});

it.each([
  { samePath: true, sameName: false },
  { samePath: false, sameName: false },
  { samePath: true, sameName: true },
  { samePath: false, sameName: true },
])(
  "keeps selected Skill host authority across concurrent workspaces %j",
  async ({ samePath, sameName }) => {
    const root = temps.make("skill-host-identity-");
    const gateway = path.join(root, "project");
    const bundled = path.join(root, "bundled");
    await fs.mkdir(bundled);
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
    vi.stubEnv("HOME", root);
    vi.stubEnv("OPENCLAW_HOME", root);
    const write = async (dir: string, name: string, body: string) => {
      await fs.mkdir(path.join(dir, "skills/guide"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "skills/guide/SKILL.md"),
        ["---", "name: " + name, "description: fixture", "---", body].join("\n"),
      );
    };
    await write(gateway, "project-guide", "Gateway project instructions");
    await fs.writeFile(path.join(gateway, "skills/guide/ordinary.txt"), "Gateway ordinary file");
    const releases: Array<() => void> = [];
    try {
      await Promise.all(
        ["alice", "bob"].map(async (user) => {
          const workspace = path.join(root, user, "agent");
          const physicalNode = path.join(root, user, "node");
          const nodeRoot = samePath ? gateway : path.join(root, "remote-project");
          const nodeName = sameName ? "project-guide" : "node-guide";
          await fs.mkdir(workspace, { recursive: true });
          await write(physicalNode, nodeName, user + " node instructions");
          const loadNode = () => {
            const entries = loadWorkspaceSkills(physicalNode, { workspaceOnly: true });
            for (const entry of entries) {
              entry.skill.filePath = path.join(nodeRoot, "skills/guide/SKILL.md");
              entry.skill.baseDir = path.join(nodeRoot, "skills/guide");
            }
            return entries;
          };
          const readInstructions = vi.fn(
            async (filePath: string, options: { signal?: AbortSignal }) => {
              expect(filePath).toBe(path.join(nodeRoot, "skills/guide/SKILL.md"));
              return fs.readFile(path.join(physicalNode, "skills/guide/SKILL.md"), {
                ...options,
                encoding: "utf8",
              });
            },
          );
          const release = registerAgentWorkspaceAccess(workspace, {
            bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
            loadSkills: async () => ({
              entries: loadNode(),
              executionEntries: [],
              runtime: { platform: process.platform, bins: [] },
            }),
            skillResources: {
              readInstructions,
              readSkillFiles: vi.fn(),
              resolveExplicitSkill: vi.fn(),
            },
          });
          releases.push(release);
          const config = { plugins: { enabled: false }, skills: { load: { watch: false } } };
          const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
            workspaceDir: workspace,
            executionWorkspaceDir: gateway,
            executionWorkspaceFileHost: "gateway",
            config,
            agentId: "main",
            watch: false,
          });
          const prepared = await prepareEmbeddedSkills({
            attempt: { config, bootstrapWorkspaceDir: workspace, skillsSnapshot: snapshot },
            sandbox: undefined,
            effectiveWorkspace: gateway,
            sessionAgentId: "main",
            includeCodeModeSkills: true,
            applySkillEnvironment: false,
          });
          const project = requireNamedSkill(prepared.codeModeSkills, "project-guide");
          expect(project.source.readContent).toBeUndefined();
          expect(await readCodeModeSkill(project)).toContain(
            sameName ? user + " node instructions" : "Gateway project instructions",
          );
          if (!sameName) {
            const node = requireNamedSkill(prepared.codeModeSkills, "node-guide");
            expect(node.location).toBe("workspace-skill://workspace/node-guide/SKILL.md");
            const read = createOpenClawCodingToolsInternal(
              {
                config,
                skillsSnapshot: prepared.skillsSnapshotForRun,
                workspaceDir: gateway,
              },
              prepared.skillReadResources,
            ).find((tool) => tool.name === "read")!;
            expect(
              getTextContent(
                await read.execute("gateway-file", {
                  path: path.join(gateway, "skills/guide/ordinary.txt"),
                }),
              ),
            ).toContain("Gateway ordinary file");
            expect(readInstructions).not.toHaveBeenCalled();
            expect(
              getTextContent(await read.execute("gateway-skill", { path: project.location })),
            ).toContain("Gateway project instructions");
            expect(readInstructions).not.toHaveBeenCalled();
            expect(
              getTextContent(await read.execute("workspace-skill", { path: node.location })),
            ).toContain(user + " node instructions");
            if (!samePath) {
              const collidingGatewayFile = path.join(nodeRoot, "skills/guide/config.json");
              await fs.mkdir(path.dirname(collidingGatewayFile), { recursive: true });
              await fs.writeFile(collidingGatewayFile, '{"owner":"gateway"}');
              expect(
                getTextContent(
                  await read.execute("gateway-collision", { path: collidingGatewayFile }),
                ),
              ).toContain('"gateway"');
              expect(
                getTextContent(
                  await read.execute("workspace-skill-physical", {
                    path: path.join(nodeRoot, "skills/guide/SKILL.md"),
                  }),
                ),
              ).toContain(user + " node instructions");
              const relativeRead = createOpenClawCodingToolsInternal(
                {
                  config,
                  skillsSnapshot: prepared.skillsSnapshotForRun,
                  workspaceDir: nodeRoot,
                },
                prepared.skillReadResources,
              ).find((tool) => tool.name === "read")!;
              expect(
                getTextContent(
                  await relativeRead.execute("workspace-skill-relative", {
                    path: "skills/guide/SKILL.md",
                  }),
                ),
              ).toContain(user + " node instructions");
            }
            expect(await readCodeModeSkill(node)).toContain(user + " node instructions");
            const expectedWorkspaceReads = samePath ? 2 : 4;
            expect(readInstructions).toHaveBeenCalledTimes(expectedWorkspaceReads);
            await expect(
              readCodeModeSkill({
                ...project,
                source: { ...project.source, readContent: "prepared project" },
              }),
            ).resolves.toBe("prepared project");
            expect(readInstructions).toHaveBeenCalledTimes(expectedWorkspaceReads);
            release();
            await expect(readCodeModeSkill(node)).rejects.toThrow("stopped or not ready");
            await expect(readCodeModeSkill(project)).resolves.toContain(
              "Gateway project instructions",
            );
            await write(physicalNode, "updated-guide", user + " reconnected instructions");
            bumpSkillsSnapshotVersion({ workspaceDir: physicalNode, reason: "remote-node" });
            const rebound = registerAgentWorkspaceAccess(workspace, {
              bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
              loadSkills: async () => ({
                entries: loadNode(),
                executionEntries: [],
                runtime: { platform: process.platform, bins: [] },
              }),
              skillResources: {
                readInstructions,
                readSkillFiles: vi.fn(),
                resolveExplicitSkill: vi.fn(),
              },
            });
            releases.push(rebound);
            bumpSkillsSnapshotVersion({ workspaceDir: workspace, reason: "remote-node" });
            const refreshed = await resolveReusableWorkspaceSkillSnapshot({
              workspaceDir: workspace,
              executionWorkspaceDir: gateway,
              executionWorkspaceFileHost: "gateway",
              config,
              agentId: "main",
              existingSnapshot: snapshot,
              watch: false,
            });
            expect(refreshed.shouldRefresh).toBe(true);
            const next = await prepareEmbeddedSkills({
              attempt: {
                config,
                bootstrapWorkspaceDir: workspace,
                skillsSnapshot: refreshed.snapshot,
              },
              effectiveWorkspace: gateway,
              sandbox: undefined,
              sessionAgentId: "main",
              includeCodeModeSkills: true,
              applySkillEnvironment: false,
            });
            expect(next.codeModeSkills.some((skill) => skill.name === "node-guide")).toBe(false);
            await expect(
              readCodeModeSkill(requireNamedSkill(next.codeModeSkills, "updated-guide")),
            ).resolves.toContain(user + " reconnected instructions");
            await expect(
              readCodeModeSkill(requireNamedSkill(next.codeModeSkills, "project-guide")),
            ).resolves.toContain("Gateway project instructions");
            await expect(readCodeModeSkill(node)).rejects.toThrow("stopped or not ready");
            next.restoreSkillEnv();
          }
          prepared.restoreSkillEnv();
        }),
      );
    } finally {
      for (const release of releases) {
        release();
      }
    }
  },
);
