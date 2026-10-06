// Qa Lab tests cover live transport CLI and adapter contribution discovery.
import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  adapterRuntimeLoads,
  createDiscordAdapter,
  createSlackAdapter,
  createWhatsAppAdapter,
  listQaRunnerCliContributions,
  runLiveTransportQaSuiteCommand,
  runTelegram,
  suiteRuntimeLoads,
} = vi.hoisted(() => ({
  adapterRuntimeLoads: { discord: 0, slack: 0, whatsapp: 0 },
  createDiscordAdapter: vi.fn(async () => ({ id: "discord" })),
  createSlackAdapter: vi.fn(async () => ({ id: "slack" })),
  createWhatsAppAdapter: vi.fn(async () => ({ id: "whatsapp" })),
  listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(() => []),
  runLiveTransportQaSuiteCommand: vi.fn(),
  runTelegram: vi.fn(),
  suiteRuntimeLoads: { count: 0 },
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions,
}));
vi.mock("./shared/live-transport-suite.runtime.js", () => {
  suiteRuntimeLoads.count += 1;
  return {
    runLiveTransportQaSuiteCommand,
    runStandardLiveTransportQaSuiteCommand: runLiveTransportQaSuiteCommand,
  };
});
vi.mock("./telegram/cli.runtime.js", () => ({ runQaTelegramCommand: runTelegram }));
vi.mock("./discord/adapter.runtime.js", () => {
  adapterRuntimeLoads.discord += 1;
  return { createDiscordQaTransportAdapter: createDiscordAdapter };
});
vi.mock("./slack/adapter.runtime.js", () => {
  adapterRuntimeLoads.slack += 1;
  return { createSlackQaTransportAdapter: createSlackAdapter };
});
vi.mock("./whatsapp/adapter.runtime.js", () => {
  adapterRuntimeLoads.whatsapp += 1;
  return { createWhatsAppQaTransportAdapter: createWhatsAppAdapter };
});

import { listLiveTransportQaCliRegistrations } from "./cli.js";

const STANDARD_LANES = ["discord", "slack", "whatsapp"] as const;

function requireRegistration(commandName: string) {
  const registration = listLiveTransportQaCliRegistrations().find(
    (candidate) => candidate.commandName === commandName,
  );
  if (!registration) {
    throw new Error(`missing ${commandName} QA registration`);
  }
  return registration;
}

function registerCommand(commandName: string) {
  const qa = new Command("qa").exitOverride().configureOutput({ writeErr: () => {} });
  requireRegistration(commandName).register(qa);
  const command = qa.commands.find((candidate) => candidate.name() === commandName);
  if (!command) {
    throw new Error(`missing ${commandName} Commander command`);
  }
  return { command, qa };
}

describe("live transport QA contributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listQaRunnerCliContributions.mockReturnValue([]);
  });

  it("registers all three dedicated commands without loading suite or adapter runtimes", () => {
    const suiteLoadsBefore = suiteRuntimeLoads.count;
    const adapterLoadsBefore = { ...adapterRuntimeLoads };
    for (const commandName of STANDARD_LANES) {
      registerCommand(commandName);
    }

    expect(suiteRuntimeLoads.count).toBe(suiteLoadsBefore);
    expect(adapterRuntimeLoads).toEqual(adapterLoadsBefore);
  });

  it.each(["discord", "slack", "whatsapp"] as const)(
    "routes the shipped %s command through the shared suite host",
    async (commandName) => {
      const registration = listLiveTransportQaCliRegistrations().find(
        (candidate) => candidate.commandName === commandName,
      );
      const qa = new Command();
      registration?.register(qa);

      await qa.parseAsync(["node", "openclaw", commandName, "--scenario", `${commandName}-canary`]);

      expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith({
        channelId: commandName,
        options: expect.objectContaining({ scenarioIds: [`${commandName}-canary`] }),
      });
    },
  );

  it("parses standard live command options into suite inputs", async () => {
    const { command, qa } = registerCommand("discord");
    await qa.parseAsync([
      "node",
      "openclaw",
      "discord",
      "--repo-root",
      "/repo",
      "--output-dir",
      "/proof",
      "--provider-mode",
      "mock-openai",
      "--model",
      "openai/primary",
      "--alt-model",
      "openai/alternate",
      "--scenario",
      "discord-canary",
      "--fast",
      "--allow-failures",
      "--sut-account",
      "qa-sut",
      "--credential-source",
      "convex",
      "--credential-role",
      "ci",
    ]);
    expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith({
      channelId: "discord",
      options: {
        repoRoot: "/repo",
        outputDir: "/proof",
        providerMode: "mock-openai",
        primaryModel: "openai/primary",
        alternateModel: "openai/alternate",
        scenarioIds: ["discord-canary"],
        fastMode: true,
        allowFailures: true,
        sutAccountId: "qa-sut",
        credentialSource: "convex",
        credentialRole: "ci",
        failFast: undefined,
        listScenarios: undefined,
        profile: undefined,
      },
    });
    expect(command.helpInformation()).toContain("Usage: qa discord [options]");
  });

  it("maps the Discord Crabline driver", async () => {
    const qa = new Command();
    requireRegistration("discord").register(qa);

    await qa.parseAsync(["node", "openclaw", "discord", "--channel-driver", "crabline"]);

    expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith({
      channelId: "discord",
      options: expect.objectContaining({ channelDriver: "crabline" }),
    });
  });

  it.each(["slack", "whatsapp"] as const)(
    "does not expose an unsupported Crabline driver on the %s command",
    async (commandName) => {
      const { qa } = registerCommand(commandName);

      await expect(
        qa.parseAsync(["node", "openclaw", commandName, "--channel-driver", "crabline"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
      expect(runLiveTransportQaSuiteCommand).not.toHaveBeenCalled();
    },
  );

  it("preserves standard command defaults, duplicate scenarios, and dispatch errors", async () => {
    const commandName = "discord";
    const { qa } = registerCommand(commandName);

    await qa.parseAsync([
      "node",
      "openclaw",
      commandName,
      "--scenario",
      " first ",
      "--scenario",
      " ",
      "--scenario",
      "first",
      "--scenario",
      "second",
    ]);
    expect(runLiveTransportQaSuiteCommand).toHaveBeenLastCalledWith({
      channelId: commandName,
      options: {
        allowFailures: false,
        alternateModel: undefined,
        credentialRole: undefined,
        credentialSource: undefined,
        failFast: undefined,
        fastMode: undefined,
        listScenarios: undefined,
        outputDir: undefined,
        primaryModel: undefined,
        profile: undefined,
        providerMode: "live-frontier",
        repoRoot: undefined,
        scenarioIds: ["first", "first", "second"],
        sutAccountId: "sut",
      },
    });

    const failure = new Error(`${commandName} suite failed`);
    runLiveTransportQaSuiteCommand.mockRejectedValueOnce(failure);
    const next = registerCommand(commandName).qa.parseAsync(["node", "openclaw", commandName]);
    await expect(next).rejects.toBe(failure);
  });

  it("rejects a missing standard option value before suite dispatch", async () => {
    const commandName = "discord";
    const { qa } = registerCommand(commandName);

    await expect(qa.parseAsync(["node", "openclaw", commandName, "--model"])).rejects.toThrow(
      "option '--model <ref>' argument missing",
    );
    expect(runLiveTransportQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("keeps all three adapter runtimes lazy and preserves factory failure identity", async () => {
    const suiteLoadsBefore = suiteRuntimeLoads.count;
    const adapterLoadsBefore = { ...adapterRuntimeLoads };

    for (const commandName of STANDARD_LANES) {
      const factory = requireRegistration(commandName).adapterFactory;
      if (!factory) {
        throw new Error(`missing ${commandName} QA adapter factory`);
      }
      const create =
        commandName === "discord"
          ? createDiscordAdapter
          : commandName === "slack"
            ? createSlackAdapter
            : createWhatsAppAdapter;
      const failure = new Error(`${commandName} adapter failed`);
      create.mockRejectedValueOnce(failure);

      const pending = factory.create({
        adapterOptions: {},
        channelId: commandName,
        credentials: {
          acquire: vi.fn(),
          startHeartbeat: vi.fn(),
        },
        driver: "live",
        messages: {
          addInboundMessage: vi.fn(),
          addOutboundMessage: vi.fn(),
          editMessage: vi.fn(),
        },
        outputDir: "/qa-output",
      });
      await expect(pending).rejects.toBe(failure);
      expect(adapterRuntimeLoads[commandName]).toBe(adapterLoadsBefore[commandName] + 1);
    }

    expect(suiteRuntimeLoads.count).toBe(suiteLoadsBefore);
  });

  it("keeps the specialized Telegram command runner", async () => {
    const registration = listLiveTransportQaCliRegistrations().find(
      (candidate) => candidate.commandName === "telegram",
    );
    const qa = new Command();
    registration?.register(qa);

    await qa.parseAsync(["node", "openclaw", "telegram", "--scenario", "telegram-canary"]);

    expect(runTelegram).toHaveBeenCalledWith({
      allowFailures: false,
      alternateModel: undefined,
      concurrency: undefined,
      credentialFile: undefined,
      credentialRole: undefined,
      credentialSource: undefined,
      failFast: undefined,
      fastMode: undefined,
      listScenarios: false,
      outputDir: undefined,
      primaryModel: undefined,
      profile: undefined,
      providerMode: "live-frontier",
      repoRoot: undefined,
      scenarioIds: ["telegram-canary"],
      sutAccountId: "sut",
    });
  });

  it.each(["discord", "telegram"])(
    "does not expose worker concurrency for the shared-instance %s command",
    async (commandName) => {
      const registration = listLiveTransportQaCliRegistrations().find(
        (candidate) => candidate.commandName === commandName,
      );
      const qa = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registration?.register(qa);

      await expect(
        qa.parseAsync(["node", "openclaw", commandName, "--concurrency", "2"]),
      ).rejects.toThrow("unknown option '--concurrency'");
      expect(runLiveTransportQaSuiteCommand).not.toHaveBeenCalled();
      expect(runTelegram).not.toHaveBeenCalled();
    },
  );
});
