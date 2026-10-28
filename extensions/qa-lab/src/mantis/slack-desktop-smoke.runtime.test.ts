import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MantisPhaseTimings } from "../mantis-phase-timer.runtime.js";
import type { MantisCrabboxReportSummary } from "./report.js";
import { createMantisCommandRunner } from "./run.test-support.js";
import { runMantisSlackDesktopSmoke } from "./slack-desktop-smoke.runtime.js";
import {
  SLACK_ARTIFACT_TEST_CHANNEL,
  copySlackSmokeArtifacts,
  writeApprovalCheckpointArtifacts,
} from "./slack-desktop-smoke.test-support.js";

// mock-isolation: Preserve actual module exports and create a fresh managed-binary mock per suite.
vi.mock("@openclaw/crabbox-provider/cli-runtime-api.js", async () =>
  (await import("./run.test-support.js")).mockManagedCrabboxBinary(),
);

function expectContains(value: unknown, snippets: string[]) {
  for (const snippet of snippets) {
    expect(value).toContain(snippet);
  }
}

type Commands = ReturnType<typeof createMantisCommandRunner>["commands"];
const remoteCommand = (commands: Commands) =>
  commands.find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run");
type Summary = MantisCrabboxReportSummary & {
  hydrateMode: string;
  timings: MantisPhaseTimings;
};

function createRunner(
  options: {
    id?: string;
    fail?: "run" | "inspect" | "stop";
    metadata?: Record<string, unknown>;
    artifacts?: Record<string, string>;
    onCommand?: Parameters<typeof createMantisCommandRunner>[1];
    onCopy?: (outputDir: string) => Promise<void>;
  } = {},
) {
  return createMantisCommandRunner(
    {
      host: "203.0.113.10",
      id: options.id ?? "cbx_abc123",
      provider: "hetzner",
      sshKey: "/tmp/key",
      sshPort: "2222",
      sshUser: "crabbox",
    },
    async (command, args, execution) => {
      await options.onCommand?.(command, args, execution);
      if (command === "/tmp/crabbox" && args[0] === options.fail) {
        throw new Error(`Crabbox ${options.fail} failed`);
      }
      if (command === "rsync") {
        const outputDir = await copySlackSmokeArtifacts(args, {
          "slack-desktop-smoke.png": "png",
          "remote-metadata.json": `${JSON.stringify(options.metadata ?? { qaExitCode: 0 })}\n`,
          ...options.artifacts,
        });
        await options.onCopy?.(outputDir);
      }
    },
  );
}

describe("mantis Slack desktop smoke runtime", () => {
  let repoRoot: string;
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  function runSmoke(options: NonNullable<Parameters<typeof runMantisSlackDesktopSmoke>[0]>) {
    return runMantisSlackDesktopSmoke({
      crabboxBin: "/tmp/crabbox",
      repoRoot,
      now: () => new Date("2026-05-04T13:00:00.000Z"),
      ...options,
    });
  }
  async function runFixture(
    options: Parameters<typeof runSmoke>[0],
    fixture: Parameters<typeof createRunner>[0] = {},
  ) {
    const { commands, runner } = createRunner(fixture);
    const result = await runSmoke({ ...options, commandRunner: runner });
    const summary: Summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
    return { ...result, commands, summary };
  }
  beforeEach(async () => {
    previousExitCode = process.exitCode;
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-slack-desktop-smoke-"));
  });
  afterEach(async () => {
    process.exitCode = previousExitCode;
    stderrWrite.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock("./cli.runtime.js");
    await fs.rm(repoRoot, { force: true, recursive: true });
  });
  it("leases a desktop box, runs Slack QA inside it, copies artifacts, and stops on pass", async () => {
    const runtimeEnv = {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "openai-runtime-key",
      OPENCLAW_QA_SLACK_CHANNEL_ID: "C123",
      OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "app-token",
      OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "sut-token",
    };
    const result = await runFixture(
      {
        env: runtimeEnv,
        freshPr: "openclaw/openclaw#85141",
        primaryModel: "openai/gpt-5.4",
        scenarioIds: ["slack-canary"],
        slackUrl: "https://app.slack.com/client/T123/C123",
      },
      { artifacts: { "slack-desktop-smoke.mp4": "mp4" } },
    );
    const { commands } = result;
    expect(result.status).toBe("pass");
    expect(result.outputDir).toBe(
      path.join(repoRoot, ".artifacts/qa-e2e/mantis/slack-desktop-2026-05-04T13-00-00-000Z"),
    );
    const warmupArgs = commands.find((entry) => entry.args[0] === "warmup")?.args ?? [];
    expect(warmupArgs[warmupArgs.indexOf("--class") + 1]).toBe("beast");
    expect(commands.map((entry) => entry.args[0])).toEqual([
      "warmup",
      "inspect",
      "run",
      "-az",
      "stop",
    ]);
    expect(
      commands.every((entry) => entry.env?.OPENCLAW_LIVE_OPENAI_KEY === "openai-runtime-key"),
    ).toBe(true);
    const remoteScript = expectDefined(
      remoteCommand(commands)?.args.at(-1),
      "generated Slack remote script",
    );
    const authScript = expectDefined(
      remoteScript.split("<<'MANTIS_SLACK_AUTH'\n")[1]?.split("\nMANTIS_SLACK_AUTH")[0],
      "generated Slack auth script",
    );
    const pinScript = expectDefined(
      remoteScript.split("read -r pnpm_version pnpm_sha512 < <(node -e '\n")[1]?.split("\n')")[0],
      "generated pnpm pin validator",
    );
    for (const ok of [true, false]) {
      const write = vi.fn<(chunk: string) => boolean>(() => true);
      const probe = {
        env: { OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "fixture-token" },
        stdout: { write },
        exitCode: 0,
      };
      await runInNewContext("(async () => {" + authScript + "})()", {
        process: probe,
        AbortSignal: { timeout: () => undefined },
        fetch: async () => ({
          json: async () => ({ ok, team_id: "Tfixture", user_id: "Ufixture" }),
        }),
      });
      expect(probe.exitCode).toBe(ok ? 0 : 1);
      expect(write).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ ok, team_id: "Tfixture", user_id: "Ufixture" }),
      );
    }
    const hash = "a".repeat(128);
    for (const valid of [true, false]) {
      let output = "";
      const probe = { exitCode: 0 };
      runInNewContext(pinScript, {
        process: probe,
        console: {
          log: (chunk: string) => {
            output += chunk;
          },
        },
        require: (name: string) => {
          if (name !== "./package.json") {
            throw new Error("unexpected validator dependency");
          }
          return { packageManager: valid ? "pnpm@12.5.1+sha512." + hash : "pnpm@12.5.1" };
        },
      });
      expect(probe.exitCode).toBe(valid ? 0 : 1);
      expect(output).toBe(valid ? "12.5.1 " + hash : "");
    }
    expectContains(remoteScript, [
      "hydrate_mode='source'",
      'grep "  $node_archive$" SHASUMS256.txt | sha256sum -c -',
      'sha512sum "$pnpm_archive"',
      "pnpm install --frozen-lockfile --prefer-offline",
      "pnpm build",
      "openclaw qa slack",
      "--scenario 'slack-canary'",
      'slack_qa_output_dir=".artifacts/qa-e2e/mantis/$(basename "$out")/slack-qa"',
      '--output-dir "$slack_qa_output_dir"',
      'timeout --kill-after=15s "${remote_command_timeout_seconds}s" bash -c run_mantis_remote_body >"$out/slack-desktop-command.log" 2>&1 &',
      "MANTIS_REMOTE_HEARTBEAT",
      'tail -n 200 "$diagnostic_file"',
      "OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR",
      `const response = await fetch("https://slack.com/api/auth.test", {
  method: "POST",
  headers: { authorization: \`Bearer \${token}\` },
  signal: AbortSignal.timeout(15_000),
});`,
    ]);
    expect(remoteScript).not.toContain('--output-dir "$out/slack-qa"');
    expect(remoteScript).not.toContain('test -s "$out/slack-desktop-smoke.png"');
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    expect(result.summary).toMatchObject({
      hydrateMode: "source",
      status: "pass",
    });
  });

  it("runs approval checkpoint mode with default approval scenarios and records screenshots", async () => {
    const expectedScenarios = ["slack-approval-exec-native", "slack-approval-plugin-native"];
    const result = await runFixture(
      {
        approvalCheckpoints: true,
        slackChannelId: SLACK_ARTIFACT_TEST_CHANNEL,
      },
      { onCopy: (outputDir) => writeApprovalCheckpointArtifacts(outputDir, expectedScenarios) },
    );
    expect(result.status).toBe("pass");
    const remoteScript = remoteCommand(result.commands)?.args.at(-1);
    expectContains(remoteScript, [
      "approval_checkpoints=1",
      'export OPENCLAW_QA_SLACK_CHANNEL_ID="$slack_channel_id"',
      "--scenario 'slack-approval-exec-native'",
      "--scenario 'slack-approval-plugin-native'",
      "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR",
      "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS",
      'cat >"$out/approval-checkpoint-watcher.mjs"',
      "OPENCLAW_MANTIS_APPROVAL_BROWSER_BIN",
      "Rendered from the Slack API message observed by QA",
      "--headless=new",
      "Slack QA exited before all expected approval checkpoints",
      'if [ "$qa_exit" -eq 0 ]; then\n        wait "$watcher_pid"',
      'cp "$out/approval-checkpoints/slack-approval-plugin-native-pending.png" "$out/slack-desktop-smoke.png"',
      'cp "$out/approval-checkpoints/slack-approval-exec-native-pending.png" "$out/slack-desktop-smoke.png"',
    ]);
    expect(remoteScript).not.toContain('node >"$out/approval-checkpoint-watcher.mjs"');
    expect(remoteScript).not.toContain('spawn("scrot", [screenshotPath]');
    expect(
      result.approvalCheckpointScreenshotPaths?.map((file) =>
        path.relative(result.outputDir, file),
      ),
    ).toEqual([
      "approval-checkpoints/slack-approval-exec-native-pending.png",
      "approval-checkpoints/slack-approval-exec-native-resolved.png",
      "approval-checkpoints/slack-approval-plugin-native-pending.png",
      "approval-checkpoints/slack-approval-plugin-native-resolved.png",
    ]);
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain(
      "Approval checkpoint slack-approval-plugin-native resolved",
    );
  });

  it("supports prehydrated remote workspaces without installing or building inside the VM", async () => {
    const result = await runFixture(
      { hydrateMode: "prehydrated", leaseId: "cbx_warm" },
      {
        id: "cbx_warm",
        metadata: { hydrateMode: "prehydrated", qaExitCode: 0 },
      },
    );
    expect(result.status).toBe("pass");
    const remoteScript = remoteCommand(result.commands)?.args.at(-1);
    expect(remoteScript).toContain("hydrate_mode='prehydrated'");
    expect(remoteScript).toContain("hydrate-mode=prehydrated requires node_modules");
    expect(remoteScript).toContain("hydrate-mode=prehydrated requires a built dist/ directory");
    const { summary } = result;
    expect(summary.hydrateMode).toBe("prehydrated");
    expect(summary.timings.phases.map((phase) => phase.name)).not.toContain("crabbox.warmup");
  });

  it.each([
    { expectedError: "Crabbox stop failed", failure: "Crabbox stop" },
    { expectedError: "Artifact destination is not a regular file", failure: "report write" },
  ])(
    "releases Convex Slack credentials when $failure fails",
    async ({ expectedError, failure }) => {
      vi.useFakeTimers();
      const events: string[] = [];
      const outputDir = ".artifacts/slack-desktop-convex";
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new Request(input).url;
        if (url.endsWith("/acquire")) {
          events.push("acquire");
          return json({
            credentialId: "cred-slack",
            heartbeatIntervalMs: 600_000,
            leaseToken: "lease-slack",
            leaseTtlMs: 900_000,
            payload: {
              channelId: "CLEASED",
              sutAppToken: "xapp-leased",
              sutBotToken: "xoxb-leased",
            },
            status: "ok",
          });
        }
        if (url.endsWith("/release") || url.endsWith("/heartbeat")) {
          return json({ status: "ok" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const { commands, runner } = createRunner({
        metadata: { gatewayAlive: true, qaExitCode: 0 },
        fail: failure === "Crabbox stop" ? "stop" : undefined,
        onCommand: async (command, args) => {
          events.push(`${command}:${args[0]}`);
        },
        onCopy: async () => {
          if (failure === "report write") {
            await fs.mkdir(path.join(repoRoot, outputDir, "mantis-slack-desktop-smoke-report.md"));
          }
        },
      });
      await expect(
        runSmoke({
          commandRunner: runner,
          credentialRole: "ci",
          credentialSource: "convex",
          env: {
            CI: "1",
            OPENAI_API_KEY: "openai-runtime-key",
            OPENCLAW_QA_CONVEX_SECRET_CI: "convex-secret",
            OPENCLAW_QA_CONVEX_SITE_URL: "https://example.convex.site",
            PATH: process.env.PATH,
          },
          gatewaySetup: true,
          keepLease: false,
          outputDir,
        }),
      ).rejects.toThrow(expectedError);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(events.indexOf("acquire")).toBeGreaterThan(events.indexOf("/tmp/crabbox:inspect"));
      expect(events.indexOf("acquire")).toBeLessThan(events.indexOf("/tmp/crabbox:run"));
      const runCommand = remoteCommand(commands);
      expect(runCommand?.env).toMatchObject({
        OPENCLAW_MANTIS_SLACK_APP_TOKEN: "xapp-leased",
        OPENCLAW_MANTIS_SLACK_BOT_TOKEN: "xoxb-leased",
        OPENCLAW_MANTIS_SLACK_CHANNEL_ID: "CLEASED",
        OPENCLAW_QA_SLACK_CHANNEL_ID: "CLEASED",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-leased",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-leased",
      });
      const remoteScript = runCommand?.args.at(-1);
      expectContains(remoteScript, [
        "setup_gateway=1",
        "openclaw gateway run",
        '</dev/null >"$out/openclaw-gateway.log"',
        'kill -0 "$gateway_pid"',
        'disown "$gateway_pid"',
      ]);
      expect(fetchMock.mock.calls.map(([url]) => new Request(url).url)).toEqual([
        "https://example.convex.site/qa-credentials/v1/acquire",
        "https://example.convex.site/qa-credentials/v1/release",
      ]);
      expect(commands.map((entry) => entry.args[0])).toContain("stop");
    },
  );

  it.each(["run", "inspect"] as const)(
    "stops a created no-keep lease when %s fails",
    async (failure) => {
      const result = await runFixture(
        { keepLease: false },
        {
          id: "cbx_fade123",
          metadata: {},
          fail: failure,
        },
      );
      expect(result.status).toBe("fail");
      expect(result.summary.crabbox).toMatchObject({
        createdLease: true,
        id: "cbx_fade123",
      });
      expect(result.commands).toContainEqual(
        expect.objectContaining({
          command: "/tmp/crabbox",
          args: ["stop", "--provider", "hetzner", "cbx_fade123"],
        }),
      );
    },
  );

  it.each([
    { gatewaySetup: true, qaExitCode: 0, status: "pass", phase: "accepted" },
    { gatewaySetup: false, qaExitCode: 7, status: "fail", phase: "pass" },
  ])("uses remote metadata for the $gatewaySetup gateway verdict", async (testCase) => {
    const { gatewaySetup, qaExitCode, status, phase } = testCase;
    const result = await runFixture(
      {
        gatewaySetup,
        leaseId: gatewaySetup ? undefined : "cbx_abc123",
        env: gatewaySetup
          ? {
              OPENAI_API_KEY: "openai-runtime-key",
              OPENCLAW_MANTIS_SLACK_APP_TOKEN: "xapp-direct",
              OPENCLAW_MANTIS_SLACK_BOT_TOKEN: "xoxb-direct",
              PATH: process.env.PATH,
            }
          : undefined,
      },
      {
        metadata: { gatewayAlive: gatewaySetup, qaExitCode },
        fail: gatewaySetup ? "run" : undefined,
      },
    );
    const { summary } = result;
    expect([result.status, summary.status]).toEqual([status, status]);
    expect(summary.timings.phases.find(({ name }) => name === "crabbox.remote_run")?.status).toBe(
      phase,
    );
    if (!gatewaySetup) {
      expect(summary.error).toContain("Slack QA exited with code 7");
    }
  });

  it.each([false, true])("validates approval CLI gateway=%s", async (gatewaySetup) => {
    vi.resetModules();
    const command = vi.fn(async () => undefined);
    vi.doMock("./cli.runtime.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./cli.runtime.js")>()),
      runMantisSlackDesktopSmokeCommand: command,
    }));
    const { registerMantisCli } = await import("./cli.js");
    const qa = new Command("qa");
    registerMantisCli(qa);
    await qa.parseAsync([
      "node",
      "openclaw",
      "mantis",
      "slack-desktop-smoke",
      "--approval-checkpoints",
      ...(gatewaySetup
        ? ["--gateway-setup"]
        : ["--market", "on-demand", "--scenario", "slack-approval-plugin-native"]),
    ]);
    if (gatewaySetup) {
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("--approval-checkpoints cannot be used with --gateway-setup"),
      );
      expect(process.exitCode).toBe(1);
      expect(command).not.toHaveBeenCalled();
    } else {
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalCheckpoints: true,
          gatewaySetup: undefined,
          market: "on-demand",
          scenarioIds: ["slack-approval-plugin-native"],
        }),
      );
    }
  });
});
