import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillWorkshopCli } from "./cli.js";

const mocks = vi.hoisted(() => {
  return {
    archiveWorkshopSkill: vi.fn(),
    config: {},
    restoreWorkshopSkill: vi.fn(),
    routeSkillsCliRequest: vi.fn(),
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
  restoreWorkshopSkill: mocks.restoreWorkshopSkill,
}));
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
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["archive", "--reason superseded", { name: "release-notes", reason: "superseded" }],
    ["restore", "--version saved-v1", { name: "release-notes", versionId: "saved-v1" }],
  ] as const)(
    "routes %s mutations for the selected agent as the user",
    async (method, flags, params) => {
      const mutate = method === "archive" ? mocks.archiveWorkshopSkill : mocks.restoreWorkshopSkill;
      mutate.mockResolvedValue({ agentId: "writer", skillName: "release-notes" });
      mocks.routeSkillsCliRequest.mockImplementation(
        (request: { loadLocal: () => Promise<unknown> }) => request.loadLocal(),
      );

      await runCli(`skills workshop ${method} release-notes --agent writer ${flags} --json`);

      expect(mocks.routeSkillsCliRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          resolved: expect.objectContaining({ agentId: "writer" }),
          method: `skills.workshop.${method}`,
          params,
          mutation: true,
        }),
      );
      expect(mutate).toHaveBeenCalledExactlyOnceWith(
        { config: mocks.config, agentId: "writer", actor: "user" },
        params,
      );
    },
  );

  it("rejects an explicitly blank --version instead of restoring the newest version", async () => {
    await expect(
      runCli(["skills", "workshop", "restore", "release-notes", "--version", ""]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.routeSkillsCliRequest).not.toHaveBeenCalled();
    expect(mocks.restoreWorkshopSkill).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error.mock.calls[0]?.[0]).toContain("--version must not be blank");
  });
});
