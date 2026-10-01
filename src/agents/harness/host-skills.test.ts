import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

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
    const result = await read.execute("read-guide", { name: "guide" });
    expect(result.content).toEqual([{ type: "text", text: "Complete sandbox instructions" }]);
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: runtimePath, maxBytes: 256 * 1024 }),
    );
    host.closeHost();
    await expect(read.execute("closed", { name: "guide" })).rejects.toThrow();
    expect(readFile).toHaveBeenCalledOnce();
  } finally {
    host.closeHost();
    host.closeAdmission();
  }
});
