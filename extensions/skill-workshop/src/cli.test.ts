import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillWorkshopCli } from "./cli.js";

// Gateway-first routing, offline custody (the Gateway lock) and transport fallback belong to
// the host's `routeSkillsCliRequest`; src/cli/skills-cli.workshop-contract.test.ts pins them
// end to end. These tests pin what the plugin hands that router and how it renders results.
const mocks = vi.hoisted(() => {
  return {
    archiveWorkshopSkill: vi.fn(),
    config: {},
    listWorkshopChanges: vi.fn(),
    restoreWorkshopSkill: vi.fn(),
    routeSkillsCliRequest: vi.fn<(request: RouteRequest) => Promise<unknown>>(),
    defaultRuntime: {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`__exit__:${code}`);
      }),
    },
  };
});

vi.mock("openclaw/plugin-sdk/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime")>()),
  defaultRuntime: mocks.defaultRuntime,
}));
vi.mock("openclaw/plugin-sdk/skill-workshop-host-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-workshop-host-cli")>()),
  resolveSkillsWorkspace: async ({ agentId }: { agentId?: string }) => ({
    config: mocks.config,
    agentId: agentId ?? "main",
    workspaceDir: "/tmp/workspace",
  }),
  routeSkillsCliRequest: mocks.routeSkillsCliRequest,
}));
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  archiveWorkshopSkill: mocks.archiveWorkshopSkill,
  listWorkshopChanges: mocks.listWorkshopChanges,
  restoreWorkshopSkill: mocks.restoreWorkshopSkill,
  viewWorkshopSkill: vi.fn(),
}));
vi.mock("./workshop-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workshop-list.js")>()),
  buildSkillsWorkshopListResult: vi.fn(),
}));

type RouteRequest = {
  resolved: { agentId: string };
  method: string;
  params: Record<string, unknown>;
  mutation: boolean;
  loadLocal: () => Promise<unknown>;
};

/** Answers like the host when no Gateway owns the state: the plugin's local path runs. */
function noGatewayOwnsState() {
  mocks.routeSkillsCliRequest.mockImplementation((request: RouteRequest) => request.loadLocal());
}

const change = {
  id: "change-1",
  agentId: "writer",
  skillName: "release-notes",
  action: "archive",
  actor: "user",
  summary: "archived: superseded",
  versionId: "20260929T010203004Z-archive",
  createdAtMs: Date.now() - 5 * 60_000,
};
const context = { config: mocks.config, agentId: "writer", actor: "user" };
const namedSkill = { agentId: "main", name: "release-notes" };
const version = { ...namedSkill, versionId: "v1" };
const archivedVersion = (id: string, action: string) => ({ id, action, createdAtMs: 1 });
async function runCli(args: string | string[]) {
  const program = new Command().enablePositionalOptions().exitOverride();
  // The core `skills` parent's own options; the plugin adds `workshop` under it.
  const skills = program
    .command("skills")
    .option("--agent <id>", "Target agent workspace")
    .option("--json", "Output as JSON", false);
  const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
  registerSkillWorkshopCli(createTestPluginApi({ registerCli }));
  await registerCli.mock.calls[0]![0]({
    program: skills,
    parentPath: ["skills"],
    config: mocks.config,
    logger: console,
  });
  return program.parseAsync(typeof args === "string" ? args.split(" ") : args, { from: "user" });
}

describe("skills workshop cli", () => {
  beforeEach(() => {
    mocks.routeSkillsCliRequest.mockReset();
    mocks.archiveWorkshopSkill.mockReset();
    mocks.listWorkshopChanges.mockReset();
    mocks.restoreWorkshopSkill.mockReset();
    for (const fn of Object.values(mocks.defaultRuntime)) {
      fn.mockClear();
    }
  });

  it.each([
    ["--agent writer list", "list", { agentId: "writer" }, false],
    ["changes --limit 5 --agent writer", "changes", { agentId: "writer", limit: 5 }, false],
    [
      "show release-notes --file references/a.md",
      "read",
      { ...namedSkill, filePath: "references/a.md" },
      false,
    ],
    ["show release-notes --version v1", "read", version, false],
    [
      "archive release-notes --reason superseded",
      "archive",
      { ...namedSkill, reason: "superseded" },
      true,
    ],
    ["restore release-notes --version v1", "restore", version, true],
  ] as const)("routes %s to %s", async (argv, method, params, mutation) => {
    mocks.routeSkillsCliRequest.mockResolvedValue({ changes: [], change, content: "", skills: [] });

    await runCli(`skills workshop ${argv} --json`);

    const requests = mocks.routeSkillsCliRequest.mock.calls.map(([request]) => ({
      method: request.method,
      params: { agentId: request.resolved.agentId, ...request.params },
      mutation: request.mutation,
    }));
    expect(requests).toStrictEqual([{ method: `skills.workshop.${method}`, params, mutation }]);
  });

  it("rejects an explicitly blank --version instead of restoring the newest version", async () => {
    mocks.routeSkillsCliRequest.mockResolvedValue({ change });

    await expect(
      runCli(["skills", "workshop", "restore", "release-notes", "--version", ""]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.routeSkillsCliRequest).not.toHaveBeenCalled();
    expect(mocks.restoreWorkshopSkill).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error.mock.calls[0]?.[0]).toContain("--version must not be blank");
  });

  it("renders learned skills, archived skills, and changes as text", async () => {
    mocks.routeSkillsCliRequest.mockResolvedValue({
      agentId: "main",
      mode: "auto",
      root: "/tmp/agent/workshop-skills",
      skills: [
        {
          name: "release-notes",
          description: "Draft release notes from merged PRs",
          updatedAtMs: Date.now() - 2 * 3_600_000,
          sizeBytes: 120,
          files: ["SKILL.md"],
          useCount: 3,
        },
      ],
      archived: [
        { name: "old-deploy", live: false, versions: [archivedVersion("v2", "archive")] },
        { name: "release-notes", live: true, versions: [archivedVersion("v1", "patch")] },
      ],
    });
    await runCli("skills workshop list");
    const listed = mocks.defaultRuntime.writeStdout.mock.calls[0]?.[0] as string;
    expect(listed).toContain("release-notes");
    expect(listed).toContain("updated 2h ago  uses=3  Draft release notes from merged PRs");
    expect(listed).toMatch(/Archived:[^\n]*\nold-deploy {2}versions=1\n$/);

    mocks.routeSkillsCliRequest.mockResolvedValue({ changes: [change] });
    await runCli("skills workshop changes");
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenLastCalledWith(
      "5m ago  user  archive  release-notes  archived: superseded  version=20260929T010203004Z-archive\n",
    );
  });

  it.each([
    [
      "archive",
      "--reason superseded",
      { name: "release-notes", reason: "superseded" },
      "Archived release-notes. Undo with:",
    ],
    [
      "restore",
      "--version saved-v1",
      { name: "release-notes", versionId: "saved-v1" },
      "Restored release-notes.\n",
    ],
  ] as const)(
    "runs %s locally as the user when no Gateway owns the state",
    async (method, args, params, output) => {
      noGatewayOwnsState();
      const mutate = method === "archive" ? mocks.archiveWorkshopSkill : mocks.restoreWorkshopSkill;
      mutate.mockResolvedValue(change);
      if (method === "archive") {
        mocks.restoreWorkshopSkill.mockResolvedValue({ ...change, action: "restore" });
      }

      await runCli(`skills workshop ${method} release-notes --agent writer ${args}`);

      expect(mutate).toHaveBeenCalledWith(context, params);
      expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
        expect.stringContaining(output),
      );
      if (method === "archive") {
        const [, undo] = mocks.defaultRuntime.writeStdout.mock
          .lastCall![0].trim()
          .split("Undo with: ");
        expect(undo).toMatch(/^openclaw /);
        await runCli(undo!.split(" ").slice(1));
        expect(mocks.restoreWorkshopSkill).toHaveBeenCalledWith(context, {
          name: "release-notes",
          versionId: undefined,
        });
      }
    },
  );

  it("reads changes locally when no Gateway answers", async () => {
    noGatewayOwnsState();
    mocks.listWorkshopChanges.mockResolvedValue([change]);

    await runCli("skills workshop changes --limit 3 --agent writer --json");

    expect(mocks.listWorkshopChanges).toHaveBeenCalledExactlyOnceWith("writer", { limit: 3 });
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({ changes: [change] });
  });
});
