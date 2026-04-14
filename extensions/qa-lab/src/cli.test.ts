import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runQaCredentialsAddCommand,
  runQaCredentialsListCommand,
  runQaCredentialsRemoveCommand,
  runQaTelegramCommand,
} = vi.hoisted(() => ({
  runQaCredentialsAddCommand: vi.fn(),
  runQaCredentialsListCommand: vi.fn(),
  runQaCredentialsRemoveCommand: vi.fn(),
  runQaTelegramCommand: vi.fn(),
}));

const { listQaRunnerCliContributions } = vi.hoisted(() => ({
  listQaRunnerCliContributions: vi.fn(() => [
    {
      pluginId: "qa-matrix",
      commandName: "matrix",
      status: "available" as const,
      registration: {
        commandName: "matrix",
        register: vi.fn((qa: Command) => {
          qa.command("matrix").action(() => undefined);
        }),
      },
    },
  ]),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  listQaRunnerCliContributions,
}));

vi.mock("./live-transports/telegram/cli.runtime.js", () => ({
  runQaTelegramCommand,
}));

vi.mock("./cli.runtime.js", () => ({
  runQaCredentialsAddCommand,
  runQaCredentialsListCommand,
  runQaCredentialsRemoveCommand,
}));

import { registerQaLabCli } from "./cli.js";

describe("qa cli registration", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    runQaCredentialsAddCommand.mockReset();
    runQaCredentialsListCommand.mockReset();
    runQaCredentialsRemoveCommand.mockReset();
    runQaTelegramCommand.mockReset();
    listQaRunnerCliContributions.mockReset().mockReturnValue([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        status: "available",
        registration: {
          commandName: "matrix",
          register: vi.fn((qa: Command) => {
            qa.command("matrix").action(() => undefined);
          }),
        },
      },
    ]);
    registerQaLabCli(program);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers the matrix and telegram live transport subcommands", () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    expect(qa).toBeDefined();
    expect(qa?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["matrix", "telegram", "credentials"]),
    );
  });

  it("delegates discovered qa runner registration through the generic host seam", () => {
    const [{ registration }] = listQaRunnerCliContributions.mock.results[0]?.value;
    expect(registration.register).toHaveBeenCalledTimes(1);
  });

  it("shows an install hint when the matrix runner plugin is unavailable", async () => {
    listQaRunnerCliContributions.mockReset().mockReturnValue([]);
    const missingProgram = new Command();
    registerQaLabCli(missingProgram);

    await expect(missingProgram.parseAsync(["node", "openclaw", "qa", "matrix"])).rejects.toThrow(
      "openclaw plugins install @openclaw/qa-matrix",
    );
  });

  it("shows an enable hint when the matrix runner plugin is installed but blocked", async () => {
    listQaRunnerCliContributions.mockReset().mockReturnValue([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        description: "Run the Matrix live QA lane",
        status: "blocked",
      },
    ]);
    const blockedProgram = new Command();
    registerQaLabCli(blockedProgram);

    await expect(blockedProgram.parseAsync(["node", "openclaw", "qa", "matrix"])).rejects.toThrow(
      'Enable or allow plugin "qa-matrix"',
    );
  });

  it("routes telegram CLI defaults into the lane runtime", async () => {
    await program.parseAsync(["node", "openclaw", "qa", "telegram"]);

    expect(runQaTelegramCommand).toHaveBeenCalledWith({
      repoRoot: undefined,
      outputDir: undefined,
      providerMode: "live-frontier",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: false,
      scenarioIds: [],
      sutAccountId: "sut",
      credentialSource: undefined,
      credentialRole: undefined,
    });
  });

  it("routes credential add flags into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "credentials",
      "add",
      "--kind",
      "telegram",
      "--payload-file",
      "qa/payload.json",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--note",
      "shared lane",
      "--site-url",
      "https://first-schnauzer-821.convex.site",
      "--endpoint-prefix",
      "/qa-credentials/v1",
      "--actor-id",
      "maintainer-local",
      "--json",
    ]);

    expect(runQaCredentialsAddCommand).toHaveBeenCalledWith({
      kind: "telegram",
      payloadFile: "qa/payload.json",
      repoRoot: "/tmp/openclaw-repo",
      note: "shared lane",
      siteUrl: "https://first-schnauzer-821.convex.site",
      endpointPrefix: "/qa-credentials/v1",
      actorId: "maintainer-local",
      json: true,
    });
  });

  it("routes credential remove flags into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "credentials",
      "remove",
      "--credential-id",
      "j57b8k419ba7bcsfw99rg05c9184p8br",
      "--site-url",
      "https://first-schnauzer-821.convex.site",
      "--actor-id",
      "maintainer-local",
      "--json",
    ]);

    expect(runQaCredentialsRemoveCommand).toHaveBeenCalledWith({
      credentialId: "j57b8k419ba7bcsfw99rg05c9184p8br",
      siteUrl: "https://first-schnauzer-821.convex.site",
      actorId: "maintainer-local",
      endpointPrefix: undefined,
      json: true,
    });
  });

  it("routes credential list defaults into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "credentials",
      "list",
      "--kind",
      "telegram",
    ]);

    expect(runQaCredentialsListCommand).toHaveBeenCalledWith({
      kind: "telegram",
      status: "all",
      limit: undefined,
      showSecrets: false,
      siteUrl: undefined,
      endpointPrefix: undefined,
      actorId: undefined,
      json: false,
    });
  });
});
