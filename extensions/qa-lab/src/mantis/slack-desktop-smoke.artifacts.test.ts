import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./crabbox-runtime.js";
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
      version: "0.55.0",
    })),
  };
});

const selected = "slack-approval-plugin-native";
const unselected = "slack-approval-exec-native";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createBarrier() {
  let complete: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => complete() };
}

function createRunner(
  copy: (outputDir: string, run: number) => Promise<void>,
  failSecondRemoteRun = false,
) {
  let run = 0;
  let remoteRuns = 0;
  return vi.fn<CommandRunner>(async (command, args) => {
    if (command === "/tmp/crabbox" && args[0] === "run") {
      if (++remoteRuns === 2 && failSecondRemoteRun) {
        throw new Error("current remote failure");
      }
    }
    if (command === "/tmp/crabbox" && args[0] === "inspect") {
      return {
        stdout: JSON.stringify({
          host: "203.0.113.10",
          id: "cbx_abc123",
          sshKey: "/tmp/synthetic-key",
          sshPort: "2222",
          sshUser: "crabbox",
        }),
        stderr: "",
      };
    }
    if (command === "rsync") {
      const outputDir = args.at(-1);
      if (!outputDir) {
        throw new Error("Missing artifact copy destination");
      }
      await copy(outputDir, ++run);
    }
    return { stdout: "", stderr: "" };
  });
}

async function writeRunArtifacts(outputDir: string, scenarioIds = [selected]) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "slack-desktop-smoke.png"), "fresh screenshot");
  await fs.writeFile(path.join(outputDir, "remote-metadata.json"), '{"qaExitCode":0}');
  await writeApprovalCheckpointArtifacts(outputDir, scenarioIds);
}

async function changeCheckpoint(
  outputDir: string,
  scenarioId: string,
  state: "pending" | "resolved",
  changes: Record<string, unknown>,
) {
  const file = path.join(outputDir, "approval-checkpoints", `${scenarioId}.${state}.json`);
  const checkpoint = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...checkpoint, ...changes }));
}

describe("Mantis Slack artifact ownership", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = tempDirs.make("mantis-slack-artifacts-");
  });

  function options(commandRunner: CommandRunner, scenarioIds = [selected]) {
    return {
      approvalCheckpoints: true,
      commandRunner,
      crabboxBin: "/tmp/crabbox",
      env: {},
      leaseId: "cbx_abc123",
      now: () => new Date("2026-05-04T13:00:00.000Z"),
      outputDir: ".artifacts/reused",
      repoRoot,
      scenarioIds,
      slackChannelId: SLACK_ARTIFACT_TEST_CHANNEL,
    };
  }

  it("keeps overlapping runs from accepting each other's artifacts", async () => {
    const copied = createBarrier();
    const release = createBarrier();
    const firstRun = runMantisSlackDesktopSmoke(
      options(
        createRunner(async (outputDir) => {
          await writeRunArtifacts(outputDir);
          copied.resolve();
          await release.promise;
        }),
      ),
    );
    const firstRunSettled = firstRun.then(
      () => undefined,
      () => undefined,
    );
    let secondStatus: string | undefined;
    try {
      await Promise.race([
        copied.promise,
        firstRun.then(() => {
          throw new Error("first run finished before copying artifacts");
        }),
      ]);
      const second = await runMantisSlackDesktopSmoke(options(createRunner(async () => {})));
      secondStatus = second.status;
    } finally {
      release.resolve();
      await firstRunSettled;
    }
    expect((await firstRun).status).toBe("pass");
    expect(secondStatus).toBe("fail");
    expect(
      (await fs.readdir(path.join(repoRoot, ".artifacts/reused"))).some((name) =>
        name.startsWith(".slack-run-"),
      ),
    ).toBe(false);
  });

  it.each([
    { missing: "metadata", error: "current remote failure" },
    { missing: "screenshot", error: "Slack desktop screenshot is missing" },
    { missing: "checkpoint", error: `Approval checkpoint ${selected}.resolved is missing` },
  ])(
    "rejects old $missing when a reused output directory receives incomplete evidence",
    async ({ missing, error }) => {
      const runner = createRunner(async (outputDir, run) => {
        if (run === 1) {
          await writeRunArtifacts(outputDir, [selected, unselected]);
          await fs.writeFile(path.join(outputDir, "slack-desktop-smoke.mp4"), "old video");
          return;
        }
        if (missing !== "metadata") {
          await fs.writeFile(path.join(outputDir, "remote-metadata.json"), '{"qaExitCode":0}');
        }
        if (missing !== "screenshot") {
          await fs.writeFile(path.join(outputDir, "slack-desktop-smoke.png"), "new screenshot");
        }
        await writeApprovalCheckpointArtifacts(
          outputDir,
          [selected],
          missing === "checkpoint" ? `${selected}.resolved.json` : undefined,
        );
      }, missing === "metadata");
      const first = await runMantisSlackDesktopSmoke(options(runner));
      expect(first.status).toBe("pass");
      const firstSummary = JSON.parse(await fs.readFile(first.summaryPath, "utf8"));
      const unrelated = path.join(first.outputDir, "unrelated.log");
      const unselectedPath = path.join(
        first.outputDir,
        "approval-checkpoints",
        `${unselected}.pending.json`,
      );
      const unselectedBytes = await fs.readFile(unselectedPath);
      await fs.writeFile(unrelated, "retained diagnostics");

      const second = await runMantisSlackDesktopSmoke(options(runner));
      const summary = JSON.parse(await fs.readFile(second.summaryPath, "utf8"));
      expect(second.status).toBe("fail");
      expect(summary.error).toContain(error);
      if (missing === "metadata") {
        expect(
          summary.timings.phases.find(
            (phase: { name: string }) => phase.name === "crabbox.remote_run",
          )?.status,
        ).toBe("fail");
      }
      expect(summary.remoteOutputDir).not.toBe(firstSummary.remoteOutputDir);
      await expect(fs.readFile(unrelated, "utf8")).resolves.toBe("retained diagnostics");
      await expect(fs.readFile(unselectedPath)).resolves.toEqual(unselectedBytes);
      await expect(
        fs.lstat(path.join(second.outputDir, "slack-desktop-smoke.mp4")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(second.outputDir)).some((name) => name.startsWith(".slack-run-")),
      ).toBe(false);
    },
  );

  it.each([
    { overrides: { scenarioIds: ["slack-canary"] }, error: "--approval-checkpoints only supports" },
    { overrides: { gatewaySetup: true }, error: "--approval-checkpoints cannot be used" },
    {
      overrides: { env: { OPENCLAW_MANTIS_HYDRATE_MODE: "invalid" } },
      error: "Unsupported Mantis Slack desktop hydrate mode",
    },
  ])("preserves prior reports when options are invalid: $error", async ({ overrides, error }) => {
    const runner = createRunner(async () => {});
    const outputDir = path.join(repoRoot, ".artifacts/reused");
    await fs.mkdir(outputDir, { recursive: true });
    const summary = path.join(outputDir, "mantis-slack-desktop-smoke-summary.json");
    const report = path.join(outputDir, "mantis-slack-desktop-smoke-report.md");
    await fs.writeFile(summary, '{"status":"pass","prior":true}');
    await fs.writeFile(report, "prior good report");

    await expect(runMantisSlackDesktopSmoke({ ...options(runner), ...overrides })).rejects.toThrow(
      error,
    );
    expect(runner).not.toHaveBeenCalled();
    await expect(fs.readFile(summary, "utf8")).resolves.toBe('{"status":"pass","prior":true}');
    await expect(fs.readFile(report, "utf8")).resolves.toBe("prior good report");
  });

  it.each([
    { changes: { approvalId: "different-opaque-id" }, error: "pending approval interaction" },
    { changes: { messageTs: "99.000000" }, error: "pending approval interaction" },
    { changes: { channelId: "COTHER" }, error: "pending approval interaction" },
    { changes: { approvalKind: "exec" }, error: "approval kind" },
    { changes: { decision: null }, error: "approval decision" },
  ])("rejects fresh mismatched approval evidence: $changes", async ({ changes, error }) => {
    const runner = createRunner(async (outputDir) => {
      await writeRunArtifacts(outputDir);
      await changeCheckpoint(outputDir, selected, "resolved", changes);
    });
    const result = await runMantisSlackDesktopSmoke(options(runner));
    expect(result.status).toBe("fail");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
    expect(summary.error).toContain(error);
  });

  it.each(["approvalId", "messageTs"])(
    "rejects a replayed %s across selected scenarios",
    async (field) => {
      const runner = createRunner(async (outputDir) => {
        await writeRunArtifacts(outputDir, [selected, unselected]);
        const value = field === "approvalId" ? `${selected}:approval` : "1.000000";
        for (const state of ["pending", "resolved"] as const) {
          await changeCheckpoint(outputDir, unselected, state, { [field]: value });
        }
      });
      const result = await runMantisSlackDesktopSmoke(options(runner, [selected, unselected]));
      expect(result.status).toBe("fail");
      const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
      expect(summary.error).toContain("reuses another scenario's approval interaction");
    },
  );

  it("accepts the actual native and Codex checkpoint kinds with distinct opaque identities", async () => {
    const scenarios = [
      unselected,
      selected,
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
    ];
    const runner = createRunner(async (outputDir) => {
      await writeRunArtifacts(outputDir, scenarios);
      const codexScenario = "slack-codex-approval-exec-native";
      for (const state of ["pending", "resolved"] as const) {
        await changeCheckpoint(outputDir, codexScenario, state, {
          channelId: "CLEASED",
          messageTs: "1.000000",
          threadTs: state === "pending" ? null : "1.000000",
        });
      }
    });
    const result = await runMantisSlackDesktopSmoke(options(runner, scenarios));
    expect(result.status).toBe("pass");
    expect(result.approvalCheckpointScreenshotPaths).toHaveLength(8);
  });

  it("rejects an acknowledgement for the wrong checkpoint state", async () => {
    const runner = createRunner(async (outputDir) => {
      await writeRunArtifacts(outputDir);
      const ack = path.join(outputDir, "approval-checkpoints", `${selected}.resolved.ack.json`);
      await fs.writeFile(
        ack,
        JSON.stringify({
          version: 1,
          scenarioId: selected,
          state: "pending",
          screenshotPath: `${selected}-resolved.png`,
        }),
      );
    });
    const result = await runMantisSlackDesktopSmoke(options(runner));
    expect(result.status).toBe("fail");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
    expect(summary.error).toContain("unexpected state");
  });
});
