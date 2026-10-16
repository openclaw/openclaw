import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSlackApprovalScenario,
  waitForSlackApprovalMessage,
} from "../live-transports/slack/slack-live.approvals.js";
import type { SlackQaFetchFunction } from "../live-transports/slack/slack-live.contracts.js";
import {
  slackQaApprovalExecNativeScenario,
  slackQaApprovalPluginNativeScenario,
  slackQaCodexApprovalExecNativeScenario,
  slackQaCodexApprovalPluginNativeScenario,
} from "../live-transports/slack/slack-live.scenario-implementations.js";
import { loadSlackQaRuntime } from "../live-transports/slack/slack-plugin.runtime.js";
import { readQaScenarioById } from "../scenario-catalog.js";
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
      version: "999.0.0",
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

const approvalScenarios = [
  {
    id: "slack-approval-exec-native",
    expectedKind: "exec",
    implementation: slackQaApprovalExecNativeScenario,
    expectedMethod: undefined,
    approvalId: "7d84-a1",
    channelId: "CAPPROVALA",
    messageTs: "10.010001",
    threadTs: "9.010001",
  },
  {
    id: "slack-approval-plugin-native",
    expectedKind: "plugin",
    implementation: slackQaApprovalPluginNativeScenario,
    expectedMethod: undefined,
    approvalId: "2c39-b2",
    channelId: "CAPPROVALB",
    messageTs: "20.020002",
    threadTs: "19.020002",
  },
  {
    id: "slack-codex-approval-exec-native",
    expectedKind: "plugin",
    implementation: slackQaCodexApprovalExecNativeScenario,
    expectedMethod: "item/commandExecution/requestApproval",
    approvalId: "8e15-c3",
    channelId: "CAPPROVALC",
    messageTs: "30.030003",
    threadTs: "29.030003",
  },
  {
    id: "slack-codex-approval-plugin-native",
    expectedKind: "plugin",
    implementation: slackQaCodexApprovalPluginNativeScenario,
    expectedMethod: "item/fileChange/requestApproval",
    approvalId: "4f62-d4",
    channelId: "CAPPROVALD",
    messageTs: "40.040004",
    threadTs: "39.040004",
  },
] as const;

async function writeProducedApprovalArtifacts(
  outputDir: string,
  row: (typeof approvalScenarios)[number],
) {
  const scenario = readQaScenarioById(row.id);
  expect(scenario.execution).toMatchObject({ kind: "flow", channel: "slack" });
  const run = row.implementation.buildRun("sut");
  if (run.kind !== "approval" && run.kind !== "codex-approval") {
    throw new Error("Expected an approval scenario run");
  }
  expect(run.approvalKind).toBe(row.expectedKind);
  expect(run.kind === "codex-approval" ? run.appServerMethod : undefined).toBe(row.expectedMethod);
  const checkpointDir = path.join(outputDir, "approval-checkpoints");
  const phases: string[] = [];
  const checkpoints = new Map<string, string>();
  let resolved = false;
  const call = vi.fn(async (method: string, args?: unknown) => {
    expect(method).toBe(row.expectedKind + ".approval.resolve");
    expect(args).toEqual({ decision: "allow-once", id: row.approvalId });
    phases.push("resolve");
    resolved = true;
    return {};
  });
  const fetch: SlackQaFetchFunction = async (input) => {
    expect(new URL(String(input)).pathname).toBe("/api/conversations.history");
    phases.push(resolved ? "observe-resolved" : "observe-pending");
    const heading = row.expectedKind === "exec" ? "Exec" : "Plugin";
    return Response.json({
      ok: true,
      messages: [
        {
          user: "sut",
          ts: row.messageTs,
          thread_ts: row.threadTs,
          text:
            heading + (resolved ? " approval: Allowed once " : " approval required ") + run.token,
          blocks: resolved
            ? []
            : [
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Allow Once" },
                      action_id: "approval",
                      value:
                        "openclaw:approval:v1:" +
                        JSON.stringify({
                          approvalId: row.approvalId,
                          approvalKind: row.expectedKind,
                          decision: "allow-once",
                        }),
                    },
                  ],
                },
              ],
        },
      ],
    });
  };
  const client = loadSlackQaRuntime().createSlackWebClient("xoxb-qa-checkpoint-fixture", { fetch });
  const observation = {
    approvalKind: run.approvalKind,
    channelId: row.channelId,
    client,
    decision: run.decision,
    observedMessages: [],
    oldestTs: "1.000000",
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    sutIdentity: { userId: "sut" },
    timeoutMs: 3_000,
    token: run.token,
  };
  const pending = await waitForSlackApprovalMessage({
    ...observation,
    state: "pending",
    approvalId: row.approvalId,
  });
  const writeFile = fs.writeFile;
  // Only the external screenshot/ack transport is controlled. The real writer
  // deletes any prior ack, writes its checkpoint bytes, then receives a fresh ack.
  const watcher = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await writeFile(...args);
    const file = args[0];
    if (typeof file !== "string") {
      return;
    }
    const state = (["pending", "resolved"] as const).find(
      (checkpointState) =>
        file === path.join(checkpointDir, scenario.id + "." + checkpointState + ".json"),
    );
    if (!state) {
      return;
    }
    const raw = await fs.readFile(file, "utf8");
    checkpoints.set(state, raw);
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      scenarioId: row.id,
      state,
      approvalKind: row.expectedKind,
      approvalId: row.approvalId,
      channelId: row.channelId,
      messageTs: row.messageTs,
      threadTs: row.threadTs,
      decision: state === "pending" ? null : "allow-once",
      message: {
        hasNativeActions: state === "pending",
        actionLabels: state === "pending" ? ["Allow Once"] : [],
      },
    });
    phases.push("checkpoint-" + state);
    const screenshotPath = scenario.id + "-" + state + ".png";
    await writeFile(path.join(checkpointDir, screenshotPath), "controlled screenshot");
    await writeFile(
      path.join(checkpointDir, scenario.id + "." + state + ".ack.json"),
      JSON.stringify({ version: 1, scenarioId: scenario.id, state, screenshotPath }),
    );
  });
  vi.stubEnv("OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR", checkpointDir);
  try {
    const result = await completeSlackApprovalScenario({
      approvalId: row.approvalId,
      gateway: { call },
      observation,
      pending,
      requestStartedAt: new Date(),
      verifyDecision: async () => {
        phases.push("verify-decision");
        expect(resolved).toBe(true);
      },
    });
    expect(result.artifact).toMatchObject({
      approvalKind: row.expectedKind,
      approvalId: row.approvalId,
      channelId: row.channelId,
      pendingMessageTs: row.messageTs,
      resolvedMessageTs: row.messageTs,
      threadTs: row.threadTs,
    });
    expect(phases).toEqual([
      "observe-pending",
      "checkpoint-pending",
      "resolve",
      "verify-decision",
      "observe-resolved",
      "checkpoint-resolved",
    ]);
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    watcher.mockRestore();
    vi.unstubAllEnvs();
  }
  await fs.writeFile(path.join(outputDir, "slack-desktop-smoke.png"), "controlled screenshot");
  await fs.writeFile(path.join(outputDir, "remote-metadata.json"), '{"qaExitCode":0}');
  return checkpoints;
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
    let secondStatus: string | undefined;
    try {
      await copied.promise;
      const second = await runMantisSlackDesktopSmoke(options(createRunner(async () => {})));
      secondStatus = second.status;
    } finally {
      release.resolve();
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
    { changes: { messageTs: "99.000000" }, error: "pending approval interaction" },
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

  it.each(["messageTs"])("rejects a replayed %s across selected scenarios", async (field) => {
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
  });

  it.each(approvalScenarios)(
    "accepts real producer checkpoints for $id with opaque identities",
    async (row) => {
      let written: Map<string, string> | undefined;
      const runner = createRunner(async (outputDir) => {
        written = await writeProducedApprovalArtifacts(outputDir, row);
      });
      const result = await runMantisSlackDesktopSmoke(options(runner, [row.id]));
      const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
      expect(summary.error).toBeUndefined();
      expect(result.status).toBe("pass");
      expect(result.approvalCheckpointScreenshotPaths).toHaveLength(2);
      expect(written?.size).toBe(2);
      for (const state of ["pending", "resolved"] as const) {
        await expect(
          fs.readFile(
            path.join(result.outputDir, "approval-checkpoints", row.id + "." + state + ".json"),
            "utf8",
          ),
        ).resolves.toBe(written?.get(state));
      }
    },
  );

  it("collects all four real approval scenarios together without identity collisions", async () => {
    const produced = new Map<string, Map<string, string>>();
    const runner = createRunner(async (outputDir) => {
      for (const row of approvalScenarios) {
        produced.set(row.id, await writeProducedApprovalArtifacts(outputDir, row));
      }
    });
    const result = await runMantisSlackDesktopSmoke(
      options(
        runner,
        approvalScenarios.map((row) => row.id),
      ),
    );
    expect(JSON.parse(await fs.readFile(result.summaryPath, "utf8")).error).toBeUndefined();
    expect(result.status).toBe("pass");
    expect(result.approvalCheckpointScreenshotPaths).toHaveLength(8);
    for (const [id, checkpoints] of produced) {
      for (const [state, raw] of checkpoints) {
        await expect(
          fs.readFile(
            path.join(result.outputDir, "approval-checkpoints", id + "." + state + ".json"),
            "utf8",
          ),
        ).resolves.toBe(raw);
      }
    }
  });

  it.each(approvalScenarios)("rejects a corrupted real producer kind for $id", async (row) => {
    const runner = createRunner(async (outputDir) => {
      await writeProducedApprovalArtifacts(outputDir, row);
      await changeCheckpoint(outputDir, row.id, "resolved", {
        approvalKind: row.expectedKind === "exec" ? "plugin" : "exec",
      });
    });
    const result = await runMantisSlackDesktopSmoke(options(runner, [row.id]));
    expect(result.status).toBe("fail");
    expect(JSON.parse(await fs.readFile(result.summaryPath, "utf8")).error).toContain(
      "has an unexpected approval kind.",
    );
  });

  it.each(["approvalId", "channelId", "messageTs"])(
    "rejects a corrupted real producer %s across checkpoint states",
    async (field) => {
      const row = approvalScenarios[2];
      const runner = createRunner(async (outputDir) => {
        await writeProducedApprovalArtifacts(outputDir, row);
        await changeCheckpoint(outputDir, row.id, "resolved", {
          [field]: "different-opaque-identity",
        });
      });
      const result = await runMantisSlackDesktopSmoke(options(runner, [row.id]));
      expect(result.status).toBe("fail");
      expect(JSON.parse(await fs.readFile(result.summaryPath, "utf8")).error).toContain(
        "does not match its pending approval interaction.",
      );
    },
  );

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
