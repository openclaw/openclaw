import assert from "node:assert/strict";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeLoads: { suite: 0, discord: 0, slack: 0, whatsapp: 0 },
  createDiscordAdapter: vi.fn(async () => ({ id: "discord" })),
  createSlackAdapter: vi.fn(async () => ({ id: "slack" })),
  createWhatsAppAdapter: vi.fn(async () => ({ id: "whatsapp" })),
  runLiveTransportQaSuiteCommand: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions: () => [],
}));
// mock-isolation: Count lazy suite loads without importing or running the real QA suite.
vi.mock("./shared/live-transport-suite.runtime.js", () => {
  mocks.runtimeLoads.suite += 1;
  return {
    runLiveTransportQaSuiteCommand: mocks.runLiveTransportQaSuiteCommand,
    runStandardLiveTransportQaSuiteCommand: mocks.runLiveTransportQaSuiteCommand,
  };
});
// mock-isolation: Count lazy adapter loads and inject failures without live transports.
vi.mock("./discord/adapter.runtime.js", () => {
  mocks.runtimeLoads.discord += 1;
  return { createDiscordQaTransportAdapter: mocks.createDiscordAdapter };
});
// mock-isolation: Count lazy Slack adapter loads without booting the real transport.
vi.mock("./slack/adapter.runtime.js", () => {
  mocks.runtimeLoads.slack += 1;
  return { createSlackQaTransportAdapter: mocks.createSlackAdapter };
});
// mock-isolation: Count lazy WhatsApp adapter loads without booting the real transport.
vi.mock("./whatsapp/adapter.runtime.js", () => {
  mocks.runtimeLoads.whatsapp += 1;
  return { createWhatsAppQaTransportAdapter: mocks.createWhatsAppAdapter };
});

import { listLiveTransportQaCliRegistrations } from "./cli.js";

const STANDARD_LANES = ["discord", "slack", "whatsapp"] as const;
const adapters = {
  discord: mocks.createDiscordAdapter,
  slack: mocks.createSlackAdapter,
  whatsapp: mocks.createWhatsAppAdapter,
};
function requireRegistration(commandName: string) {
  const registration = listLiveTransportQaCliRegistrations().find(
    (candidate) => candidate.commandName === commandName,
  );
  assert(registration, `missing ${commandName} QA registration`);
  return registration;
}

function registerCommand(commandName: string) {
  const qa = new Command("qa").exitOverride().configureOutput({ writeErr: () => {} });
  requireRegistration(commandName).register(qa);
  return qa;
}

function runCommand(commandName: string, ...args: string[]) {
  return registerCommand(commandName).parseAsync(["node", "openclaw", commandName, ...args]);
}

function expectSuite(channelId: string, options: Record<string, unknown>) {
  expect(mocks.runLiveTransportQaSuiteCommand).toHaveBeenLastCalledWith({
    channelId,
    options: expect.objectContaining(options),
  });
}

describe("live transport QA contributions", () => {
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    stderrWrite.mockRestore();
  });

  it("registers all three dedicated commands without loading suite or adapter runtimes", () => {
    const loadsBefore = { ...mocks.runtimeLoads };
    for (const commandName of STANDARD_LANES) {
      registerCommand(commandName);
    }

    expect(mocks.runtimeLoads).toEqual(loadsBefore);
  });

  it.each(["slack", "whatsapp"] as const)(
    "routes the shipped %s command to its runtime",
    async (commandName) => {
      await runCommand(commandName, "--scenario", `${commandName}-canary`);
      expectSuite(commandName, { scenarioIds: [`${commandName}-canary`] });
    },
  );

  it("forwards Discord's driver and credential options", async () => {
    const qa = await runCommand(
      "discord",
      ..."--channel-driver crabline --credential-source convex --credential-role ci".split(" "),
    );
    // Generic option mappings are covered by qa-runtime.test.ts at the SDK owner.
    expectSuite("discord", {
      channelDriver: "crabline",
      credentialSource: "convex",
      credentialRole: "ci",
    });
    expect(qa.commands[0]?.helpInformation()).toContain("Usage: qa discord [options]");
  });

  it("preserves standard command defaults, duplicate scenarios, and dispatch errors", async () => {
    await runCommand(
      "discord",
      ...[" first ", " ", "first", "second"].flatMap((value) => ["--scenario", value]),
    );
    expectSuite("discord", {
      allowFailures: false,
      providerMode: "live-frontier",
      sutAccountId: "sut",
      listScenarios: undefined,
      scenarioIds: ["first", "first", "second"],
    });

    const failure = new Error("discord suite failed");
    mocks.runLiveTransportQaSuiteCommand.mockRejectedValueOnce(failure);
    await runCommand("discord");
    expect(stderrWrite).toHaveBeenCalledWith(`${failure.message}\n`);
    expect(process.exitCode).toBe(1);
  });

  it("keeps all three adapter runtimes lazy and preserves factory failure identity", async () => {
    const loadsBefore = { ...mocks.runtimeLoads };

    for (const commandName of STANDARD_LANES) {
      const factory = requireRegistration(commandName).adapterFactory;
      assert(factory, `missing ${commandName} QA adapter factory`);
      const failure = new Error(`${commandName} adapter failed`);
      adapters[commandName].mockRejectedValueOnce(failure);

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
      expect(mocks.runtimeLoads[commandName]).toBe(loadsBefore[commandName] + 1);
    }

    expect(mocks.runtimeLoads.suite).toBe(loadsBefore.suite);
  });
});
