import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { readCodeModeSkill } from "../code-mode-skills.js";
import { readInstalledSkill } from "../installed-skill-catalog.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { bindHostSkillCatalog } from "./host-skills.js";

it("binds skill reads to a late sandbox and refuses reads after host closure", async () => {
  const sourcePath = "/host/skills/guide/SKILL.md";
  const runtimePath = "/workspace/skills/guide/SKILL.md";
  const skill = {
    ...createCanonicalFixtureSkill({
      name: "guide",
      description: "Guide",
      filePath: sourcePath,
      baseDir: "/host/skills/guide",
      source: "workspace",
    }),
    readContent: "Host content must not bypass the sandbox",
  };
  const nodeSkill = {
    ...skill,
    name: "node-only",
    filePath: "node://remote/skills/node-only/SKILL.md",
  };
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: "late-sandbox-skills",
    workspaceDir: "/host",
    config: { plugins: { enabled: false } },
    skillsSnapshot: {
      prompt: "",
      skills: [
        { name: "guide", skillKey: "guide" },
        { name: "node-only", skillKey: "node-only" },
      ],
      resolvedSkills: [nodeSkill],
      discoverySkills: [skill, nodeSkill],
    },
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
  try {
    const createToolSurface = expectDefined(
      host.hostCapabilities.createToolSurface,
      "admitted host tool surface",
    );
    const tools = createToolSurface({
      workspaceDir: "/host",
      config: { plugins: { enabled: false } },
      sandbox,
    });
    const read = expectDefined(
      tools.find((tool) => tool.name === "skills_read"),
      "installed skill read tool",
    );
    const search = expectDefined(
      tools.find((tool) => tool.name === "skills_search"),
      "installed skill search tool",
    );
    expect((await search.execute("find-node", { query: "node-only" })).details).toEqual({
      skills: [],
      hasMore: false,
    });
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: runtimePath, maxBytes: 16 * 1024 }),
    );
    const result = await read.execute("read-guide", { name: "guide" });
    expect(result.content).toEqual([{ type: "text", text: "Complete sandbox instructions" }]);
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: runtimePath, maxBytes: 256 * 1024 }),
    );
    host.closeHost();
    await expect(read.execute("closed", { name: "guide" })).rejects.toThrow();
    await expect(search.execute("closed-search", { query: "sandbox" })).rejects.toThrow();
    expect(readFile).toHaveBeenCalledTimes(2);
  } finally {
    host.closeHost();
    host.closeAdmission();
  }
});

it("confines cached and retargeted skill instructions to the required root at read time", async () => {
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rooted-skills-")),
  );
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  const inside = path.join(root, "SKILL.md");
  const outside = path.join(parent, "outside.md");
  const alias = path.join(root, "alias.md");
  await fs.writeFile(inside, "Inside instructions");
  await fs.writeFile(outside, "Outside instructions");
  await fs.writeFile(alias, "Inside instructions");
  const candidates = (
    [
      ["inside", inside],
      ["outside", outside],
      ["alias", alias],
    ] as const
  ).map(([name, filePath]) =>
    Object.assign(
      createCanonicalFixtureSkill({
        name,
        description: name,
        filePath,
        baseDir: path.dirname(filePath),
        source: "workspace",
      }),
      { readContent: "Cached instructions must not bypass the root" },
    ),
  );
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Host closed");
    }
  };
  try {
    const getSkills = bindHostSkillCatalog({
      snapshot: {
        prompt: "",
        skills: candidates.map(({ name }) => ({ name, skillKey: name })),
        discoverySkills: candidates,
      },
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
    await expect(readInstalledSkill(skills, "inside")).resolves.toBe("Inside instructions");
    await expect(readCodeModeSkill(aliasSkill)).resolves.toBe("Inside instructions");
    await expect(readInstalledSkill(skills, "outside")).rejects.toThrow("Unknown installed skill");
    await fs.unlink(alias);
    await fs.symlink(outside, alias);
    await expect(readInstalledSkill(skills, "alias")).rejects.toThrow();
    await expect(readCodeModeSkill(aliasSkill)).rejects.toThrow();
    expect(() => getSkills(undefined, parent)).toThrow("escapes the captured required workspace");
    active = false;
    await expect(readInstalledSkill(skills, "inside")).rejects.toThrow("Host closed");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

it("keeps the host-owned skill root when plugin options widen placement or replace the catalog", async () => {
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-skills-")),
  );
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  const inside = path.join(root, "SKILL.md");
  const outside = path.join(parent, "outside.md");
  await fs.writeFile(inside, "Inside instructions");
  await fs.writeFile(outside, "Outside instructions");
  const candidates = [inside, outside].map((filePath, index) =>
    Object.assign(
      createCanonicalFixtureSkill({
        name: index === 0 ? "inside" : "outside",
        description: "Instructions",
        filePath,
        baseDir: path.dirname(filePath),
        source: "workspace",
      }),
      { readContent: "Cached outside instructions" },
    ),
  );
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: "required-root-skills",
    workspaceDir: root,
    cwd: root,
    sessionRoot: root,
    requireWorkspaceOnly: true,
    config: { plugins: { enabled: false } },
    skillsSnapshot: {
      prompt: "",
      skills: candidates.map(({ name }) => ({ name, skillKey: name })),
      discoverySkills: candidates,
    },
  });
  try {
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
    const read = expectDefined(
      tools.find((tool) => tool.name === "skills_read"),
      "skill reader",
    );
    expect((await read.execute("inside", { name: "inside" })).content).toEqual([
      { type: "text", text: "Inside instructions" },
    ]);
    await expect(read.execute("outside", { name: "outside" })).rejects.toThrow(
      "Unknown installed skill",
    );
    expect(() => createTools({ sessionPermissionPolicy: { root: parent, mode: "full" } })).toThrow(
      "escapes the captured required workspace",
    );
  } finally {
    host.closeHost();
    host.closeAdmission();
    await fs.rm(parent, { recursive: true, force: true });
  }
});
