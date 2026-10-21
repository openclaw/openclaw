import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
  listQaRunnerCliContributions: mocks.listQaRunnerCliContributions,
}));
// mock-isolation: Count lazy suite loads without importing or running the real QA suite.
vi.mock("./shared/live-transport-suite.runtime.js", () => {
  mocks.suiteRuntimeLoads.count += 1;
  return {
    runLiveTransportQaSuiteCommand: mocks.runLiveTransportQaSuiteCommand,
    runStandardLiveTransportQaSuiteCommand: mocks.runLiveTransportQaSuiteCommand,
  };
});
// mock-isolation: Verify CLI dispatch without loading Telegram's live transport and suite runtime.
vi.mock("./telegram/cli.runtime.js", () => ({ runQaTelegramCommand: mocks.runTelegram }));
// mock-isolation: Count lazy adapter loads and inject factory failures without the live transport.
vi.mock("./discord/adapter.runtime.js", () => {
  mocks.adapterRuntimeLoads.discord += 1;
  return { createDiscordQaTransportAdapter: mocks.createDiscordAdapter };
});
// mock-isolation: Count lazy adapter loads and inject factory failures without the live transport.
vi.mock("./slack/adapter.runtime.js", () => {
  mocks.adapterRuntimeLoads.slack += 1;
  return { createSlackQaTransportAdapter: mocks.createSlackAdapter };
});
// mock-isolation: Count lazy adapter loads and inject factory failures without the live transport.
vi.mock("./whatsapp/adapter.runtime.js", () => {
  mocks.adapterRuntimeLoads.whatsapp += 1;
  return { createWhatsAppQaTransportAdapter: mocks.createWhatsAppAdapter };
});

import { listLiveTransportQaCliRegistrations } from "./cli.js";

const STANDARD_LANES = ["discord", "slack", "whatsapp"] as const;
const DEFAULT_OPTIONS = {
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
  sutAccountId: "sut",
};

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
  return qa;
}

describe("live transport QA contributions", () => {
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.clearAllMocks();
    mocks.listQaRunnerCliContributions.mockReturnValue([]);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    stderrWrite.mockRestore();
  });

  it("registers all three dedicated commands without loading suite or adapter runtimes", () => {
    const suiteLoadsBefore = mocks.suiteRuntimeLoads.count;
    const adapterLoadsBefore = { ...mocks.adapterRuntimeLoads };
    for (const commandName of STANDARD_LANES) {
      registerCommand(commandName);
    }

    expect(mocks.suiteRuntimeLoads.count).toBe(suiteLoadsBefore);
    expect(mocks.adapterRuntimeLoads).toEqual(adapterLoadsBefore);
  });

  it.each(["slack", "whatsapp"] as const)(
    "routes the shipped %s command through the shared suite host",
    async (commandName) => {
      const qa = registerCommand(commandName);
      await qa.parseAsync(["node", "openclaw", commandName, "--scenario", `${commandName}-canary`]);

      expect(mocks.runLiveTransportQaSuiteCommand).toHaveBeenCalledWith({
        channelId: commandName,
        options: expect.objectContaining({ scenarioIds: [`${commandName}-canary`] }),
      });
    },
  );

  it("parses standard live command options into suite inputs", async () => {
    const qa = registerCommand("discord");
    await qa.parseAsync(
      `node openclaw discord --channel-driver crabline --repo-root /repo --output-dir /proof
       --provider-mode mock-openai --model openai/primary --alt-model openai/alternate
       --scenario discord-canary --fast --allow-failures --sut-account qa-sut
       --credential-source convex --credential-role ci`.split(/\s+/),
    );
    expect(mocks.runLiveTransportQaSuiteCommand).toHaveBeenCalledWith({
      channelId: "discord",
      options: {
        ...DEFAULT_OPTIONS,
        channelDriver: "crabline",
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
      },
    });
    const command = qa.commands[0];
    if (!command) {
      throw new Error("missing discord Commander command");
    }
    expect(command.helpInformation()).toContain("Usage: qa discord [options]");
  });

  it("preserves standard command defaults, duplicate scenarios, and dispatch errors", async () => {
    const qa = registerCommand("discord");
    await qa.parseAsync([
      "node",
      "openclaw",
      "discord",
      ...[" first ", " ", "first", "second"].flatMap((value) => ["--scenario", value]),
    ]);
    expect(mocks.runLiveTransportQaSuiteCommand).toHaveBeenLastCalledWith({
      channelId: "discord",
      options: { ...DEFAULT_OPTIONS, scenarioIds: ["first", "first", "second"] },
    });

    const failure = new Error("discord suite failed");
    mocks.runLiveTransportQaSuiteCommand.mockRejectedValueOnce(failure);
    await registerCommand("discord").parseAsync(["node", "openclaw", "discord"]);
    expect(stderrWrite).toHaveBeenCalledWith(`${failure.message}\n`);
    expect(process.exitCode).toBe(1);
  });

  it("keeps all three adapter runtimes lazy and preserves factory failure identity", async () => {
    const suiteLoadsBefore = mocks.suiteRuntimeLoads.count;
    const adapterLoadsBefore = { ...mocks.adapterRuntimeLoads };

    for (const commandName of STANDARD_LANES) {
      const factory = requireRegistration(commandName).adapterFactory;
      if (!factory) {
        throw new Error(`missing ${commandName} QA adapter factory`);
      }
      const create = {
        discord: mocks.createDiscordAdapter,
        slack: mocks.createSlackAdapter,
        whatsapp: mocks.createWhatsAppAdapter,
      }[commandName];
      const failure = new Error(`${commandName} adapter failed`);
      create.mockRejectedValueOnce(failure);

      const pending = factory.create({
        adapterOptions: {},
        channelId: commandName,
        credentials: { acquire: vi.fn(), startHeartbeat: vi.fn() },
        driver: "live",
        messages: {
          addInboundMessage: vi.fn(),
          addOutboundMessage: vi.fn(),
          editMessage: vi.fn(),
        },
        outputDir: "/qa-output",
      });
      await expect(pending).rejects.toBe(failure);
      expect(mocks.adapterRuntimeLoads[commandName]).toBe(adapterLoadsBefore[commandName] + 1);
    }

    expect(mocks.suiteRuntimeLoads.count).toBe(suiteLoadsBefore);
  });

  it("keeps the specialized Telegram command runner", async () => {
    const qa = registerCommand("telegram");
    await qa.parseAsync(["node", "openclaw", "telegram", "--scenario", "telegram-canary"]);

    expect(mocks.runTelegram).toHaveBeenCalledWith({
      ...DEFAULT_OPTIONS,
      concurrency: undefined,
      credentialFile: undefined,
      listScenarios: false,
      scenarioIds: ["telegram-canary"],
    });
  });
});
