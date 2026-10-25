import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_QA_RUNNER = {
  pluginId: "qa-runner-test",
  commandName: "runner-test",
  description: "Run the test live QA lane",
} as const;

function createAvailableQaRunnerContribution() {
  return {
    pluginId: TEST_QA_RUNNER.pluginId,
    commandName: TEST_QA_RUNNER.commandName,
    status: "available" as const,
    registration: {
      commandName: TEST_QA_RUNNER.commandName,
      register: vi.fn((qa: Command) => {
        qa.command(TEST_QA_RUNNER.commandName).action(() => undefined);
      }),
    },
  } satisfies QaRunnerCliContribution;
}

function blockedRunner(commandName: string = TEST_QA_RUNNER.commandName): QaRunnerCliContribution {
  return { ...TEST_QA_RUNNER, commandName, status: "blocked" };
}

const mocks = vi.hoisted(() => ({
  runtime: {
    runQaCredentialsAddCommand: vi.fn(),
    runQaCredentialsListCommand: vi.fn(),
    runQaCredentialsRemoveCommand: vi.fn(),
    runQaJsonlReplayCommand: vi.fn(),
    runQaLabSelfCheckCommand: vi.fn(),
    runQaManualLaneCommand: vi.fn(),
    runQaProfileCommand: vi.fn(),
    runQaProviderServerCommand: vi.fn(),
    runQaSuiteCommand: vi.fn(),
  },
  mantis: {
    runMantisBeforeAfterCommand: vi.fn(),
    runMantisDesktopBrowserSmokeCommand: vi.fn(),
    runMantisDiscordSmokeCommand: vi.fn(),
    runMantisSlackDesktopSmokeCommand: vi.fn(),
  },
  telegram: { runQaTelegramCommand: vi.fn() },
  report: { runQaCoverageReportCommand: vi.fn() },
  listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(),
}));
const { runtime, mantis, telegram, report, listQaRunnerCliContributions } = mocks;
const {
  runQaCredentialsAddCommand: addCredential,
  runQaCredentialsRemoveCommand: removeCredential,
  runQaCredentialsListCommand: listCredentials,
  runQaLabSelfCheckCommand: selfCheck,
  runQaProfileCommand: profile,
  runQaProviderServerCommand: provider,
  runQaSuiteCommand: suite,
} = runtime;
const {
  runMantisBeforeAfterCommand: beforeAfter,
  runMantisDesktopBrowserSmokeCommand: browserSmoke,
  runMantisDiscordSmokeCommand: discordSmoke,
  runMantisSlackDesktopSmokeCommand: slackSmoke,
} = mantis;
const { runQaTelegramCommand: runTelegram } = telegram;
const { runQaCoverageReportCommand: coverageReport } = report;
vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions: mocks.listQaRunnerCliContributions,
}));
// These module-shaped mocks keep registration tests from loading execution backends.
vi.mock("./live-transports/telegram/cli.runtime.js", () => mocks.telegram);
vi.mock("./mantis/cli.runtime.js", () => mocks.mantis);
vi.mock("./cli.runtime.js", () => mocks.runtime);
vi.mock("./cli-report.runtime.js", () => mocks.report);

import { registerQaLabCli } from "./cli.js";

describe("qa cli registration", () => {
  let program: Command;
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  function parseQa(
    args: string | readonly string[],
    flags: Record<string, string | string[] | boolean> = {},
  ) {
    return program.parseAsync([
      "node",
      "openclaw",
      "qa",
      ...(typeof args === "string" ? args.split(" ") : args),
      ...Object.entries(flags).flatMap(([key, value]) =>
        value === true
          ? [`--${key}`]
          : value === false
            ? []
            : (Array.isArray(value) ? value : [value]).flatMap((entry) => [`--${key}`, entry]),
      ),
    ]);
  }

  function invalidProgram() {
    const command = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} });
    registerQaLabCli(command);
    return command;
  }

  async function expectQaFailure(args: string | readonly string[], message: string) {
    await parseQa(args);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(process.exitCode).toBe(1);
  }

  // Each pair declares the CLI spelling independently from the runtime field.
  async function expectRoute(
    args: string | readonly string[],
    command: ReturnType<typeof vi.fn>,
    fields: Record<string, readonly [string, string | string[] | boolean]>,
    defaults: Record<string, unknown> = {},
  ) {
    await parseQa(args, Object.fromEntries(Object.values(fields)));
    expect(command).toHaveBeenCalledWith({
      ...defaults,
      ...Object.fromEntries(Object.entries(fields).map(([key, [, value]]) => [key, value])),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    previousExitCode = process.exitCode;
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    program = new Command();
    listQaRunnerCliContributions
      .mockReset()
      .mockReturnValue([createAvailableQaRunnerContribution()]);
    registerQaLabCli(program);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    stderrWrite.mockRestore();
    vi.clearAllMocks();
  });

  it("prints QA profile runtime failures", async () => {
    const message = "--output-dir must be a relative path inside the repo root.";
    profile.mockRejectedValueOnce(new Error(message));

    await expectQaFailure(
      "run --qa-profile smoke-ci --output-dir /tmp/qa-out --scenario memory-dreaming-sweep",
      message,
    );
  });

  it("prints SDK runner runtime failures", async () => {
    const message = "Telegram QA could not acquire its test credential.";
    runTelegram.mockRejectedValueOnce(new Error(message));

    await expectQaFailure(["telegram"], message);
  });

  it("registers the discovered runner", () => {
    expect(
      program.commands
        .find((command) => command.name() === "qa")
        ?.commands.map((command) => command.name()),
    ).toContain(TEST_QA_RUNNER.commandName);
  });

  it.each([
    ["run --scenario dm-chat-baseline", "qa run --scenario requires --qa-profile"],
    [
      "run --qa-profile release --evidence-mode full --exclude-test-execution-evidence",
      "--exclude-test-execution-evidence conflicts with --evidence-mode full",
    ],
    [["run", "--qa-profile", ""], "--qa-profile must not be empty."],
    [
      "run --qa-profile smoke-ci --output out.md",
      "qa run --output is only valid for the self-check mode",
    ],
  ] as const)("rejects invalid run mode %j", async (args, message) => {
    await expectQaFailure(args, message);
    expect(selfCheck).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
  });

  it("rejects unknown qa evidence modes", async () => {
    await expect(
      invalidProgram().parseAsync(
        "node openclaw qa run --qa-profile smoke-ci --evidence-mode tiny".split(" "),
      ),
    ).rejects.toThrow("--evidence-mode must be one of full, slim.");
    expect(selfCheck).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
  });

  it("routes mantis discord-smoke flags into the mantis runtime command", async () => {
    await expectRoute(
      ["mantis", "discord-smoke"],
      discordSmoke,
      {
        repoRoot: ["repo-root", "/tmp/openclaw-repo"],
        outputDir: ["output-dir", ".artifacts/qa-e2e/mantis/discord-smoke"],
        guildId: ["guild-id", "123456789012345678"],
        channelId: ["channel-id", "223456789012345678"],
        tokenFile: ["token-file", "/tmp/mantis-token"],
        message: ["message", "hello from mantis"],
        skipPost: ["skip-post", true],
      },
      { tokenEnv: undefined, tokenFileEnv: undefined },
    );
  });

  it("routes mantis before/after flags into the mantis runtime command", async () => {
    await expectRoute(
      ["mantis", "run"],
      beforeAfter,
      {
        transport: ["transport", "discord"],
        scenario: ["scenario", "discord-status-reactions-tool-only"],
        baseline: ["baseline", "origin/main"],
        candidate: ["candidate", "HEAD"],
        repoRoot: ["repo-root", "/tmp/openclaw-repo"],
        outputDir: ["output-dir", ".artifacts/qa-e2e/mantis/local-discord-status-reactions"],
        credentialSource: ["credential-source", "convex"],
        credentialRole: ["credential-role", "maintainer"],
        skipInstall: ["skip-install", true],
        skipBuild: ["skip-build", true],
      },
      { fastMode: true, providerMode: "live-frontier", signal: expect.any(AbortSignal) },
    );
  });

  it("routes mantis desktop browser smoke flags into the mantis runtime command", async () => {
    await expectRoute(["mantis", "desktop-browser-smoke"], browserSmoke, {
      repoRoot: ["repo-root", "/tmp/openclaw-repo"],
      outputDir: ["output-dir", ".artifacts/qa-e2e/mantis/desktop-browser"],
      browserUrl: ["browser-url", "https://openclaw.ai/docs"],
      htmlFile: ["html-file", "qa-artifacts/timeline.html"],
      crabboxBin: ["crabbox-bin", "/tmp/crabbox"],
      provider: ["provider", "hetzner"],
      machineClass: ["class", "beast"],
      leaseId: ["lease-id", "cbx_123abc"],
      idleTimeout: ["idle-timeout", "30m"],
      ttl: ["ttl", "90m"],
      keepLease: ["keep-lease", true],
    });
  });

  it("does not shadow mantis desktop browser runtime env defaults", async () => {
    await parseQa(["mantis", "desktop-browser-smoke", "--repo-root", "/tmp/openclaw-repo"]);

    expect(browserSmoke).toHaveBeenCalledWith({
      browserUrl: undefined,
      crabboxBin: undefined,
      htmlFile: undefined,
      idleTimeout: undefined,
      keepLease: undefined,
      leaseId: undefined,
      machineClass: undefined,
      outputDir: undefined,
      provider: undefined,
      repoRoot: "/tmp/openclaw-repo",
      ttl: undefined,
    });
  });

  it("routes mantis Slack desktop smoke flags into the mantis runtime command", async () => {
    await expectRoute(
      ["mantis", "slack-desktop-smoke"],
      slackSmoke,
      {
        repoRoot: ["repo-root", "/tmp/openclaw-repo"],
        outputDir: ["output-dir", ".artifacts/qa-e2e/mantis/slack-desktop"],
        crabboxBin: ["crabbox-bin", "/tmp/crabbox"],
        provider: ["provider", "hetzner"],
        market: ["market", "on-demand"],
        machineClass: ["machine-class", "beast"],
        leaseId: ["lease-id", "cbx_123abc"],
        freshPr: ["fresh-pr", "openclaw/openclaw#85141"],
        idleTimeout: ["idle-timeout", "45m"],
        ttl: ["ttl", "120m"],
        slackUrl: ["slack-url", "https://app.slack.com/client/T123/C123"],
        providerMode: ["provider-mode", "live-frontier"],
        primaryModel: ["model", "openai/gpt-5.6-luna"],
        alternateModel: ["alt-model", "openai/gpt-5.6-luna"],
        scenarioIds: ["scenario", ["slack-canary"]],
        credentialSource: ["credential-source", "env"],
        credentialRole: ["credential-role", "maintainer"],
        fastMode: ["fast", true],
        keepLease: ["keep-lease", true],
      },
      { gatewaySetup: undefined, slackChannelId: undefined },
    );
  });

  it.each([
    [
      ["coverage", "--repo-root", "/repo", "--output", "out.md", "--json"],
      { repoRoot: "/repo", output: "out.md", json: true },
    ],
    [
      ["coverage", "--repo-root", "/repo", "--tools", "--summary", "summary.json"],
      { repoRoot: "/repo", tools: true, summary: "summary.json" },
    ],
    [
      ["coverage", "--evidence", "evidence.json", "--json"],
      { evidence: "evidence.json", json: true },
    ],
    [
      ["coverage", "--match", "image roundtrip", "--match", "native"],
      { match: ["image roundtrip", "native"] },
    ],
  ] as const)("routes coverage options %j", async (args, expected) => {
    await parseQa([...args]);
    expect(coverageReport).toHaveBeenCalledWith({
      tools: false,
      json: false,
      match: [],
      ...expected,
    });
  });

  it("registers standalone provider server commands from the provider registry", async () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    const commandNames = qa?.commands.map((command) => command.name()) ?? [];
    expect(commandNames).toContain("mock-openai");
    expect(commandNames).toContain("aimock");

    await parseQa(["aimock", "--port", "44080"]);

    expect(provider).toHaveBeenCalledWith("aimock", {
      host: "127.0.0.1",
      port: 44080,
    });
  });

  it("normalizes signed decimal QA numeric option values through the shared parser", async () => {
    await parseQa(["aimock", "--port", "+044080"]);

    expect(provider).toHaveBeenCalledWith("aimock", {
      host: "127.0.0.1",
      port: 44080,
    });
  });

  it.each([
    [["qa", "suite", "--concurrency", "1.5"], "--concurrency must be a positive integer."],
    [["qa", "suite", "--cpus", "0x4"], "--cpus must be a positive integer."],
    [["qa", "aimock", "--port", "1e4"], "--port must be a positive integer."],
    [["qa", "ui", "--port", "65536"], "--port must be a TCP port between 1 and 65535."],
  ])("rejects invalid QA numeric option %j", async (args, message) => {
    await expect(invalidProgram().parseAsync(["node", "openclaw", ...args])).rejects.toThrow(
      message,
    );
  });

  it("shows an enable hint when a discovered runner plugin is installed but blocked", async () => {
    listQaRunnerCliContributions.mockReset().mockReturnValue([blockedRunner()]);
    program = new Command();
    registerQaLabCli(program);

    await expectQaFailure(
      [TEST_QA_RUNNER.commandName],
      `Enable or allow plugin "${TEST_QA_RUNNER.pluginId}"`,
    );
  });

  it("rejects discovered runners that collide with built-in qa subcommands", () => {
    listQaRunnerCliContributions.mockReset().mockReturnValue([blockedRunner("manual")]);

    expect(() => registerQaLabCli(new Command())).toThrow(
      'QA runner command "manual" conflicts with an existing qa subcommand',
    );
  });

  it("routes telegram CLI defaults into the lane runtime", async () => {
    await parseQa(["telegram"]);

    expect(runTelegram).toHaveBeenCalledWith({
      repoRoot: undefined,
      outputDir: undefined,
      providerMode: "live-frontier",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      allowFailures: false,
      scenarioIds: [],
      listScenarios: false,
      sutAccountId: "sut",
      credentialSource: undefined,
      credentialRole: undefined,
    });
  });

  it.each([
    ["suite", ["qa", "suite"]],
    ["profile", ["qa", "run", "--qa-profile", "smoke-ci"]],
  ])("preserves omitted --fast intent for %s runs", async (_name, args) => {
    await program.parseAsync(["node", "openclaw", ...args]);

    const call =
      suite.mock.calls[0]?.[0] ??
      profile.mock.calls[0]?.[0] ??
      runtime.runQaManualLaneCommand.mock.calls[0]?.[0];
    expect(call?.fastMode).toBeUndefined();
  });

  it.each([
    [["telegram", "--list-scenarios"], runTelegram, { listScenarios: true }],
    [["telegram", "--allow-failures"], runTelegram, { allowFailures: true }],
    [["suite", "--allow-failures"], suite, { allowFailures: true, providerMode: undefined }],
    [
      ["suite", "--runtime-pair-lane", "core", "--runtime-pair-lane", "extended,soak"],
      suite,
      { runtimePairLane: ["core", "extended,soak"] },
    ],
  ] as const)("forwards lane options %j", async (args, command, expected) => {
    await parseQa([...args]);
    expect(command).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it("routes credential add flags into the qa runtime command", async () => {
    await expectRoute(["credentials", "add"], addCredential, {
      kind: ["kind", "telegram"],
      payloadFile: ["payload-file", "qa/payload.json"],
      repoRoot: ["repo-root", "/tmp/openclaw-repo"],
      note: ["note", "shared lane"],
      siteUrl: ["site-url", "https://first-schnauzer-821.convex.site"],
      endpointPrefix: ["endpoint-prefix", "/qa-credentials/v1"],
      actorId: ["actor-id", "maintainer-local"],
      json: ["json", true],
    });
  });

  it("routes credential remove flags into the qa runtime command", async () => {
    await expectRoute(
      ["credentials", "remove"],
      removeCredential,
      {
        credentialId: ["credential-id", "j57b8k419ba7bcsfw99rg05c9184p8br"],
        siteUrl: ["site-url", "https://first-schnauzer-821.convex.site"],
        actorId: ["actor-id", "maintainer-local"],
        json: ["json", true],
      },
      { endpointPrefix: undefined },
    );
  });

  it("routes credential list defaults into the qa runtime command", async () => {
    await parseQa(["credentials", "list", "--kind", "telegram"]);

    expect(listCredentials).toHaveBeenCalledWith({
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
