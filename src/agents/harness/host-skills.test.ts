import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { readCodeModeSkill } from "../code-mode-skills.js";
import { readInstalledSkill } from "../installed-skill-catalog.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { bindHostSkillCatalog } from "./host-skills.js";

const config = { plugins: { enabled: false } };
function fixtureSkill(name: string, filePath: string, description = name) {
  return {
    ...createCanonicalFixtureSkill({
      name,
      description,
      filePath,
      baseDir: path.dirname(filePath),
      source: "workspace",
    }),
    readContent: "Cached instructions must not bypass the root",
  };
}
async function rootedSkills(prefix: string) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  const inside = path.join(root, "SKILL.md");
  const outside = path.join(parent, "outside.md");
  await fs.writeFile(inside, "Inside instructions");
  await fs.writeFile(outside, "Outside instructions");
  onTestFinished(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root, inside, outside };
}
const snapshot = (candidates: ReturnType<typeof fixtureSkill>[]) => ({
  prompt: "",
  skills: candidates.map(({ name }) => ({ name, skillKey: name })),
  discoverySkills: candidates,
});
const findTool = (tools: AnyAgentTool[], name: string) =>
  expectDefined(
    tools.find((tool) => tool.name === name),
    name,
  );

function skillContent(location: string, content: string, note = "") {
  return [
    {
      type: "text",
      text:
        `Skill location: ${location}\n` +
        "Resolve relative resource paths from the directory containing this SKILL.md.\n" +
        (note ? note + "\n\n" : "\n") +
        content,
    },
  ];
}
async function createHost(options: Parameters<typeof createAdmittedHostCapabilityTestFixture>[0]) {
  const host = await createAdmittedHostCapabilityTestFixture({ config, ...options });
  onTestFinished(() => {
    host.closeHost();
    host.closeAdmission();
  });
  return host;
}

it("binds skill reads to a late sandbox and refuses reads after host closure", async () => {
  const sourcePath = "/host/skills/guide/SKILL.md";
  const runtimePath = "/workspace/skills/guide/SKILL.md";
  const skill = {
    ...fixtureSkill("guide", sourcePath, "Guide"),
    readContent: "Host content must not bypass the sandbox",
    locationNote: "Run referenced commands inside the sandbox.",
  };
  const nodeSkill = {
    ...skill,
    name: "node-only",
    filePath: "node://remote/skills/node-only/SKILL.md",
  };
  const host = await createHost({
    runId: "late-sandbox-skills",
    workspaceDir: "/host",
    skillsSnapshot: { ...snapshot([skill, nodeSkill]), resolvedSkills: [nodeSkill] },
  });
  const readFile = vi.fn(async () => Buffer.from("Complete sandbox instructions"));
  const sandbox = createSandboxTestContext({
    overrides: {
      skillsWorkspaceDir: "/host",
      workspaceAccess: "ro",
      skillUsagePaths: [
        {
          skillName: "guide",
          skillSource: "workspace",
          skillFile: sourcePath,
          readPath: sourcePath,
        },
      ],
      fsBridge: {
        readFile,
        resolvePath: vi.fn(),
        writeFile: vi.fn(),
        mkdirp: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn(),
      },
    },
  });
  const createToolSurface = expectDefined(
    host.hostCapabilities.createToolSurface,
    "admitted host tool surface",
  );
  const tools = createToolSurface({ workspaceDir: "/host", config, sandbox });
  const read = findTool(tools, "skills_read");
  const search = findTool(tools, "skills_search");
  expect((await search.execute("find-node", { query: "node-only" })).details).toEqual({
    skills: [],
    hasMore: false,
  });
  expect(readFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: runtimePath, maxBytes: 16 * 1024 }),
  );
  const result = await read.execute("read-guide", { name: "guide" });
  expect(result.content).toEqual(
    skillContent(runtimePath, "Complete sandbox instructions", skill.locationNote),
  );
  expect(readFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: runtimePath, maxBytes: 256 * 1024 }),
  );
  host.closeHost();
  await expect(read.execute("closed", { name: "guide" })).rejects.toThrow();
  await expect(search.execute("closed-search", { query: "sandbox" })).rejects.toThrow();
  expect(readFile).toHaveBeenCalledTimes(2);
});

it("confines cached and retargeted skill instructions to the required root at read time", async () => {
  const { parent, root, inside, outside } = await rootedSkills("openclaw-rooted-skills-");
  const alias = path.join(root, "alias.md");
  await fs.writeFile(alias, "Inside instructions");
  const candidates = (
    [
      ["inside", inside],
      ["outside", outside],
      ["alias", alias],
    ] as const
  ).map(([name, filePath]) => fixtureSkill(name, filePath));
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Host closed");
    }
  };
  const getSkills = bindHostSkillCatalog({
    snapshot: snapshot(candidates),
    workspaceDir: root,
    requiredRoot: root,
    readable: true,
    assertCurrent,
  });
  const skills = getSkills();
  expect(skills.map(({ name }) => name)).toEqual(["inside", "alias"]);
  const aliasSkill = expectDefined(
    skills.find((skill) => skill.name === "alias"),
    "admitted alias",
  );
  expect(skills.every((skill) => skill.source.readContent === undefined)).toBe(true);
  await expect(readInstalledSkill(skills, "inside")).resolves.toMatchObject({
    content: "Inside instructions",
  });
  await expect(readCodeModeSkill(aliasSkill)).resolves.toBe("Inside instructions");
  await expect(readInstalledSkill(skills, "outside")).rejects.toThrow(
    "is not available to this agent",
  );
  await fs.unlink(alias);
  await fs.symlink(outside, alias);
  await expect(readInstalledSkill(skills, "alias")).rejects.toThrow();
  await expect(readCodeModeSkill(aliasSkill)).rejects.toThrow();
  expect(() => getSkills(undefined, parent)).toThrow("escapes the captured required workspace");
  active = false;
  await expect(readInstalledSkill(skills, "inside")).rejects.toThrow("Host closed");
});

it("keeps the host-owned skill root when plugin options widen placement or replace the catalog", async () => {
  const { parent, root, inside, outside } = await rootedSkills("openclaw-host-skills-");
  const candidates = [inside, outside].map((filePath, index) =>
    Object.assign(fixtureSkill(index === 0 ? "inside" : "outside", filePath, "Instructions"), {
      readContent: "Cached outside instructions",
    }),
  );
  const host = await createHost({
    runId: "required-root-skills",
    workspaceDir: root,
    cwd: root,
    sessionRoot: root,
    requireWorkspaceOnly: true,
    skillsSnapshot: snapshot(candidates),
  });
  const createTools = expectDefined(host.hostCapabilities.createToolSurface, "host tools");
  const tools = createTools({
    workspaceDir: parent,
    cwd: parent,
    requireWorkspaceOnly: undefined,
    sandbox: null,
    installedSkills: [
      {
        name: "outside",
        description: "Plugin replacement",
        location: outside,
        source: { filePath: outside, readContent: "Plugin outside instructions" },
      },
    ],
  });
  const read = findTool(tools, "skills_read");
  expect((await read.execute("inside", { name: "inside" })).content).toEqual(
    skillContent(inside, "Inside instructions"),
  );
  await expect(read.execute("outside", { name: "outside" })).rejects.toThrow(
    "is not available to this agent",
  );
  expect(() => createTools({ sessionPermissionPolicy: { root: parent, mode: "full" } })).toThrow(
    "escapes the captured required workspace",
  );
});
