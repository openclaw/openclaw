import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./crabbox-runtime.js";
import type { MantisApprovalCheckpointArtifacts } from "./slack-desktop-smoke.artifacts.js";
import { runMantisSlackDesktopSmoke } from "./slack-desktop-smoke.runtime.js";
import {
  SLACK_ARTIFACT_TEST_CHANNEL,
  writeApprovalCheckpointArtifacts,
} from "./slack-desktop-smoke.test-support.js";

vi.mock("@openclaw/crabbox-provider/cli-runtime-api.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openclaw/crabbox-provider/cli-runtime-api.js")>();
  return {
    ...actual,
    ensureManagedCrabboxBinary: vi.fn(async ({ binary }: { binary: string }) => ({
      binary,
      version: "999.0.0",
    })),
  };
});

function inspectResponse(id: string, details: { slug?: string; state?: string } = {}) {
  return {
    stdout: `${JSON.stringify({
      host: "203.0.113.10",
      id,
      provider: "hetzner",
      sshKey: "/tmp/key",
      sshPort: "2222",
      sshUser: "crabbox",
      ...details,
    })}\n`,
    stderr: "",
  };
}

type RecordedCommand = { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv };
type SmokeSummary = {
  artifacts: { approvalCheckpoints?: MantisApprovalCheckpointArtifacts };
  crabbox: { id: string; vncCommand: string };
  error?: string;
  hydrateMode: string;
  status: string;
  timings: { phases: { name: string; status: string }[]; totalMs: number };
  warning?: string;
};

async function readSummary(result: { summaryPath: string }): Promise<SmokeSummary> {
  return JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
}

function createRunner(
  id: string,
  options: {
    details?: Parameters<typeof inspectResponse>[1];
    created?: boolean;
    metadata?: Record<string, unknown>;
    files?: Record<string, string>;
    copy?: (outputDir: string) => Promise<void>;
    beforeCommand?: (command: string, args: readonly string[]) => void;
  } = {},
) {
  const commands: RecordedCommand[] = [];
  const runner = vi.fn<CommandRunner>(async (command, args, runOptions) => {
    commands.push({ command, args, env: runOptions.env });
    options.beforeCommand?.(command, args);
    if (options.created && command === "/tmp/crabbox" && args[0] === "warmup") {
      return { stdout: `ready lease ${id}\n`, stderr: "" };
    }
    if (command === "/tmp/crabbox" && args[0] === "inspect") {
      return inspectResponse(id, options.details);
    }
    if (command === "rsync") {
      const outputDir = args.at(-1);
      expect(outputDir).toBeTypeOf("string");
      if (!outputDir) {
        throw new Error("Missing artifact copy destination");
      }
      await fs.mkdir(outputDir, { recursive: true });
      for (const [file, content] of Object.entries({
        "slack-desktop-smoke.png": "png",
        "remote-metadata.json": `${JSON.stringify(options.metadata ?? { qaExitCode: 0 })}\n`,
        ...options.files,
      })) {
        await fs.writeFile(path.join(outputDir, file), content);
      }
      await options.copy?.(outputDir);
    }
    return { stdout: "", stderr: "" };
  });
  return { commands, runner };
}

function expectContains(value: unknown, expected: readonly string[]) {
  for (const text of expected) {
    expect(value).toContain(text);
  }
}

function describeFetchInput(input: RequestInfo | URL) {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

function describeFetchBody(body: BodyInit | null | undefined) {
  return body == null
    ? ""
    : typeof body === "string" || body instanceof URLSearchParams
      ? String(body)
      : `[${body.constructor.name}]`;
}

function findRun(commands: RecordedCommand[]) {
  return commands.find(({ command, args }) => command === "/tmp/crabbox" && args[0] === "run");
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function gatewayMetadata(gatewayPid: string, workspace: string) {
  return {
    gatewayAlive: true,
    gatewayPid,
    openedUrl: `https://app.slack.com/client/${workspace}`,
    qaExitCode: 0,
  };
}

async function parseCli(args: string[]) {
  vi.resetModules();
  const runMantisSlackDesktopSmokeCommand = vi.fn(async () => undefined);
  vi.doMock("./cli.runtime.js", () => ({
    runMantisBeforeAfterCommand: vi.fn(),
    runMantisDesktopBrowserSmokeCommand: vi.fn(),
    runMantisDiscordSmokeCommand: vi.fn(),
    runMantisSlackDesktopSmokeCommand,
    runMantisVisualDriverCommand: vi.fn(),
    runMantisVisualTaskCommand: vi.fn(),
  }));
  const { registerMantisCli } = await import("./cli.js");
  const qa = new Command("qa");
  registerMantisCli(qa);
  await qa.parseAsync(["node", "openclaw", "mantis", "slack-desktop-smoke", ...args]);
  vi.doUnmock("./cli.runtime.js");
  return runMantisSlackDesktopSmokeCommand;
}

describe("mantis Slack desktop smoke runtime", () => {
  let repoRoot: string;
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  function runSmoke(options: NonNullable<Parameters<typeof runMantisSlackDesktopSmoke>[0]>) {
    return runMantisSlackDesktopSmoke({ crabboxBin: "/tmp/crabbox", repoRoot, ...options });
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
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("leases a desktop box, runs Slack QA inside it, copies artifacts, and stops on pass", async () => {
    const runtimeEnv = {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "openai-runtime-key",
      OPENCLAW_QA_SLACK_CHANNEL_ID: "C123",
      OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "driver-token",
      OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "app-token",
      OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "sut-token",
    };
    const { commands, runner } = createRunner("cbx_abc123", {
      created: true,
      details: { slug: "bright-mantis", state: "active" },
      files: {
        "slack-desktop-smoke.mp4": "mp4",
        "chrome.log": "chrome\n",
        "ffmpeg.log": "ffmpeg\n",
        "slack-desktop-command.log": "qa\n",
      },
    });
    const result = await runSmoke({
      commandRunner: runner,
      env: runtimeEnv,
      freshPr: "openclaw/openclaw#85141",
      now: () => new Date("2026-05-04T13:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-test",
      primaryModel: "openai/gpt-5.4",
      scenarioIds: ["slack-canary"],
      slackUrl: "https://app.slack.com/client/T123/C123",
    });

    expect(result.status).toBe("pass");
    const warmupArgs = commands.find((entry) => entry.args[0] === "warmup")?.args ?? [];
    expect(warmupArgs[warmupArgs.indexOf("--class") + 1]).toBe("beast");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
      ["/tmp/crabbox", "stop"],
    ]);
    expect(
      commands.every((entry) => entry.env?.OPENCLAW_LIVE_OPENAI_KEY === "openai-runtime-key"),
    ).toBe(true);
    const runArgs = findRun(commands)?.args;
    expectContains(runArgs, ["--no-hydrate", "--fresh-pr", "openclaw/openclaw#85141"]);
    expect(runArgs).not.toContain("--no-sync");
    const remoteScript = runArgs?.at(-1);
    if (typeof remoteScript !== "string") {
      throw new Error("Slack remote script was not generated");
    }
    const authScript = remoteScript
      .split("<<'MANTIS_SLACK_AUTH'\n")[1]
      ?.split("\nMANTIS_SLACK_AUTH")[0];
    const pinScript = remoteScript
      .split("read -r pnpm_version pnpm_sha512 < <(node -e '\n")[1]
      ?.split("\n')")[0];
    if (!authScript || !pinScript) {
      throw new Error("Slack generated validators were not found");
    }
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
      const log = vi.fn();
      const probe = { exitCode: 0 };
      runInNewContext(pinScript, {
        process: probe,
        console: { log },
        require: (name: string) => {
          if (name !== "./package.json") {
            throw new Error("unexpected validator dependency");
          }
          return { packageManager: valid ? "pnpm@12.5.1+sha512." + hash : "pnpm@12.5.1" };
        },
      });
      expect(probe.exitCode).toBe(valid ? 0 : 1);
      if (valid) {
        expect(log).toHaveBeenCalledExactlyOnceWith("12.5.1 " + hash);
      } else {
        expect(log).not.toHaveBeenCalled();
      }
    }
    expectContains(remoteScript, [
      "hydrate_mode='source'",
      "${BROWSER:-}",
      "PNPM_STORE_DIR",
      "build-essential python3",
      "node_supports_type_stripping",
      "scripts/crabbox-untrusted-bootstrap.sh",
      "curl -fsSL --connect-timeout 10 --max-time 120 https://deb.nodesource.com/setup_22.x",
      'curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 --retry-max-time 120 --retry-all-errors "$node_base_url/SHASUMS256.txt"',
      'curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 --retry-max-time 120 --retry-all-errors "$node_base_url/$node_archive"',
      'grep "  $node_archive$" SHASUMS256.txt | sha256sum -c -',
      'export PATH="$node_root/bin:$PATH"',
      "packageManager ??",
      "[0-9a-f]{128}",
      'active_pnpm_version="$(pnpm --version 2>/dev/null || true)"',
      '"https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz"',
      'sha512sum "$pnpm_archive"',
      'chmod +x "$pnpm_cli"',
      'ln -sfn "$pnpm_cli" "$pnpm_bin_dir/pnpm"',
      'export PATH="$pnpm_bin_dir:$PATH"',
      "Expected pnpm $pnpm_version, got $active_pnpm_version.",
      "pnpm install --frozen-lockfile --prefer-offline",
      "pnpm build",
      "ffmpeg",
      "slack-desktop-smoke.mp4",
      "openclaw qa slack",
      "--scenario 'slack-canary'",
      'slack_qa_output_dir=".artifacts/qa-e2e/mantis/$(basename "$out")/slack-qa"',
      '--output-dir "$slack_qa_output_dir"',
      "copy_slack_qa_artifacts",
      "remote_command_timeout_seconds=",
      "remote-command-timeout.txt",
      'timeout --kill-after=15s "${remote_command_timeout_seconds}s" bash -c run_mantis_remote_body >"$out/slack-desktop-command.log" 2>&1 &',
      "MANTIS_REMOTE_HEARTBEAT",
      "qa_status=$?",
      "MANTIS_REMOTE_FAILURE_DIAGNOSTICS_BEGIN",
      "$out/slack-qa/qa-suite-report.md",
      "$out/slack-qa/qa-suite-summary.json",
      "$out/slack-qa/qa-evidence.json",
      'tail -n 200 "$diagnostic_file"',
      "Slack desktop screenshot is missing or empty",
      "OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR",
    ]);
    expect(remoteScript?.match(/--connect-timeout 10 --max-time 120/gu)?.length).toBe(4);
    expect(remoteScript?.match(/--retry 3 --retry-max-time 120 --retry-all-errors/gu)?.length).toBe(
      3,
    );
    expect(remoteScript).not.toContain('--output-dir "$out/slack-qa"');
    expect(remoteScript).not.toContain('test -s "$out/slack-desktop-smoke.png"');
    expect(remoteScript)
      .toContain(`const response = await fetch("https://slack.com/api/auth.test", {
  method: "POST",
  headers: { authorization: \`Bearer \${token}\` },
  signal: AbortSignal.timeout(15_000),
});`);
    const rsyncArgs = commands
      .filter((entry) => entry.command === "rsync")
      .flatMap((entry) => entry.args);
    expect(rsyncArgs).not.toContain("--delete");
    expect(rsyncArgs).toContainEqual(
      expect.stringMatching(
        /^crabbox@203\.0\.113\.10:\/tmp\/openclaw-mantis-slack-desktop-2026-05-04T13-00-00-000Z-[^/]+\/$/,
      ),
    );
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = await readSummary(result);
    expect(summary).toMatchObject({
      crabbox: {
        id: "cbx_abc123",
        vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
      },
      hydrateMode: "source",
      status: "pass",
    });
    expect(summary.timings.totalMs).toBeGreaterThanOrEqual(0);
    const phaseNames = summary.timings.phases.map((phase) => phase.name);
    expectContains(phaseNames, [
      "crabbox.warmup",
      "crabbox.inspect",
      "credentials.prepare",
      "crabbox.remote_run",
      "artifacts.copy",
    ]);
  });

  it("runs approval checkpoint mode with default approval scenarios and records screenshots", async () => {
    const expectedScenarios = ["slack-approval-exec-native", "slack-approval-plugin-native"];
    const { commands, runner } = createRunner("cbx_123abc", {
      created: true,
      details: { state: "active" },
      files: { "slack-desktop-command.log": "qa\n" },
      copy: (outputDir) => writeApprovalCheckpointArtifacts(outputDir, expectedScenarios),
    });
    const result = await runSmoke({
      commandRunner: runner,
      approvalCheckpoints: true,
      now: () => new Date("2026-05-04T13:15:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-checkpoints",
      slackChannelId: SLACK_ARTIFACT_TEST_CHANNEL,
    });

    expect(result.status).toBe("pass");
    expect(result.approvalCheckpointScreenshotPaths).toHaveLength(4);
    const remoteScript = findRun(commands)?.args.at(-1);
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
      "class='wrap'",
      "--headless=new",
      "Slack QA exited before all expected approval checkpoints",
      'if [ "$qa_exit" -eq 0 ]; then\n        wait "$watcher_pid"',
      'cp "$out/approval-checkpoints/slack-approval-plugin-native-pending.png" "$out/slack-desktop-smoke.png"',
      'cp "$out/approval-checkpoints/slack-approval-exec-native-pending.png" "$out/slack-desktop-smoke.png"',
    ]);
    expect(remoteScript).not.toContain('node >"$out/approval-checkpoint-watcher.mjs"');
    expect(remoteScript).not.toContain('spawn("scrot", [screenshotPath]');
    const summary = await readSummary(result);
    expect(summary.artifacts.approvalCheckpoints?.screenshots).toHaveLength(4);
    expect(
      summary.artifacts.approvalCheckpoints?.screenshots.map((screenshot) =>
        path.relative(result.outputDir, screenshot.screenshotPath),
      ),
    ).toEqual(
      expectedScenarios.flatMap((scenario) =>
        ["pending", "resolved"].map((state) => `approval-checkpoints/${scenario}-${state}.png`),
      ),
    );
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain(
      "Approval checkpoint slack-approval-plugin-native resolved",
    );
  });

  it("supports prehydrated remote workspaces without installing or building inside the VM", async () => {
    const { commands, runner } = createRunner("cbx_warm", {
      metadata: { hydrateMode: "prehydrated", qaExitCode: 0 },
    });
    const result = await runSmoke({
      commandRunner: runner,
      hydrateMode: "prehydrated",
      leaseId: "cbx_warm",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-prehydrated",
    });

    expect(result.status).toBe("pass");
    const remoteScript = findRun(commands)?.args.at(-1);
    expect(remoteScript).toContain("hydrate_mode='prehydrated'");
    expect(remoteScript).toContain("hydrate-mode=prehydrated requires node_modules");
    expect(remoteScript).toContain("hydrate-mode=prehydrated requires a built dist/ directory");
    const summary = await readSummary(result);
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
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = describeFetchInput(input);
        if (url.endsWith("/acquire")) {
          events.push("acquire");
          return jsonResponse({
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
          events.push(url.endsWith("/release") ? "release" : "heartbeat");
          return jsonResponse({ status: "ok" });
        }
        throw new Error(`unexpected fetch: ${url} ${describeFetchBody(init?.body)}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { commands, runner } = createRunner("cbx_c0ffee", {
        created: true,
        details: { state: "active" },
        metadata: gatewayMetadata("1234", "TLEASED/CLEASED"),
        files: { "slack-desktop-command.log": "qa\n" },
        beforeCommand(command, args) {
          events.push(`${command}:${args[0]}`);
          if (failure === "Crabbox stop" && command === "/tmp/crabbox" && args[0] === "stop") {
            throw new Error("Crabbox stop failed");
          }
        },
        async copy() {
          if (failure === "report write") {
            await fs.mkdir(
              path.join(
                repoRoot,
                ".artifacts/qa-e2e/mantis/slack-desktop-convex",
                "mantis-slack-desktop-smoke-report.md",
              ),
            );
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
          now: () => new Date("2026-05-04T14:00:00.000Z"),
          outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-convex",
        }),
      ).rejects.toThrow(expectedError);
      await vi.advanceTimersByTimeAsync(600_000);

      expect(events).not.toContain("heartbeat");
      expect(events).toContain("release");
      expect(events.indexOf("acquire")).toBeGreaterThan(events.indexOf("/tmp/crabbox:inspect"));
      expect(events.indexOf("acquire")).toBeLessThan(events.indexOf("/tmp/crabbox:run"));
      const runCommand = findRun(commands);
      expect(runCommand?.env).toMatchObject({
        OPENCLAW_MANTIS_SLACK_APP_TOKEN: "xapp-leased",
        OPENCLAW_MANTIS_SLACK_BOT_TOKEN: "xoxb-leased",
        OPENCLAW_MANTIS_SLACK_CHANNEL_ID: "CLEASED",
        OPENCLAW_QA_SLACK_CHANNEL_ID: "CLEASED",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-leased",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-leased",
      });
      const remoteScript = runCommand?.args.at(-1);
      expect(remoteScript).toContain("setup_gateway=1");
      expect(remoteScript).toContain("openclaw gateway run");
      expect(remoteScript).toContain('</dev/null >"$out/openclaw-gateway.log"');
      expect(remoteScript).toContain('kill -0 "$gateway_pid"');
      expect(remoteScript).toContain('disown "$gateway_pid"');
      expect(fetchMock.mock.calls.map(([url]) => describeFetchInput(url))).toEqual([
        "https://example.convex.site/qa-credentials/v1/acquire",
        "https://example.convex.site/qa-credentials/v1/release",
      ]);
      expect(commands.map((entry) => entry.args[0])).toContain("stop");
    },
  );

  it.each(["run", "inspect"] as const)(
    "stops a created no-keep lease when %s fails",
    async (failure) => {
      const { commands, runner } = createRunner("cbx_fade123", {
        created: true,
        details: { slug: "brisk-mantis", state: "active" },
        metadata: {},
        beforeCommand(command, args) {
          if (command === "/tmp/crabbox" && args[0] === failure) {
            throw new Error(`${failure} failed`);
          }
        },
      });
      const result = await runSmoke({
        commandRunner: runner,
        keepLease: false,
        outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-created-fail",
      });

      expect(result.status).toBe("fail");
      expect((await readSummary(result)).crabbox).toEqual({
        bin: "/tmp/crabbox",
        createdLease: true,
        id: "cbx_fade123",
        provider: "hetzner",
        vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_fade123 --open",
      });
      expect(commands).toContainEqual(
        expect.objectContaining({
          command: "/tmp/crabbox",
          args: ["stop", "--provider", "hetzner", "cbx_fade123"],
        }),
      );
    },
  );

  it("passes gateway setup when Crabbox returns non-zero after remote metadata proves success", async () => {
    const { runner } = createRunner("cbx_cafe123", {
      created: true,
      details: { state: "active" },
      metadata: gatewayMetadata("4321", "TOK/COK"),
      beforeCommand(command, args) {
        if (command === "/tmp/crabbox" && args[0] === "run") {
          throw new Error("remote command exited 1");
        }
      },
    });
    const result = await runSmoke({
      commandRunner: runner,
      env: {
        OPENAI_API_KEY: "openai-runtime-key",
        OPENCLAW_MANTIS_SLACK_APP_TOKEN: "xapp-direct",
        OPENCLAW_MANTIS_SLACK_BOT_TOKEN: "xoxb-direct",
        PATH: process.env.PATH,
      },
      gatewaySetup: true,
      now: () => new Date("2026-05-04T14:30:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-gateway-metadata",
    });

    expect(result.status).toBe("pass");
    const summary = await readSummary(result);
    expect(summary.status).toBe("pass");
    expect(summary.warning).toBeUndefined();
    expect(
      summary.timings.phases.find((phase) => phase.name === "crabbox.remote_run")?.status,
    ).toBe("accepted");
  });

  it("reports Slack QA failure from copied remote metadata when Crabbox run exits zero", async () => {
    const { runner } = createRunner("cbx_existing", { metadata: { qaExitCode: 7 } });
    const result = await runSmoke({
      commandRunner: runner,
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-metadata-fail",
    });

    expect(result.status).toBe("fail");
    const summary = await readSummary(result);
    expect(summary.status).toBe("fail");
    expect(summary.error).toContain("Slack QA exited with code 7");
    expect(
      summary.timings.phases.find((phase) => phase.name === "crabbox.remote_run")?.status,
    ).toBe("pass");
  });

  it("routes the approval checkpoints CLI flag into the Slack desktop runtime", async () => {
    const runCommand = await parseCli([
      "--approval-checkpoints",
      "--market",
      "on-demand",
      "--scenario",
      "slack-approval-plugin-native",
    ]);

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalCheckpoints: true,
        gatewaySetup: undefined,
        market: "on-demand",
        scenarioIds: ["slack-approval-plugin-native"],
      }),
    );
  });

  it("rejects mutually exclusive approval checkpoint and gateway setup CLI flags", async () => {
    const runCommand = await parseCli(["--approval-checkpoints", "--gateway-setup"]);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("--approval-checkpoints cannot be used with --gateway-setup"),
    );
    expect(process.exitCode).toBe(1);

    expect(runCommand).not.toHaveBeenCalled();
  });
});
