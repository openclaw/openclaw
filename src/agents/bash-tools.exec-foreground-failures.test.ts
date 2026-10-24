import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { getBashShellConfig } from "./shell-utils.js";

const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  cancel: vi.fn<ProcessSupervisor["cancel"]>(),
  cancelScope: vi.fn<ProcessSupervisor["cancelScope"]>(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || getBashShellConfig().shell;
const tempDirs = createTempDirTracker();
function fullExec(defaults: Parameters<typeof createExecTool>[0] = {}) {
  return createExecTool({ security: "full", ask: "off", allowBackground: false, ...defaults });
}

function requireTextContent(
  result: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>,
) {
  const content = result.content[0];
  assert(content?.type === "text", `expected text content, got ${content?.type ?? "missing"}`);
  return content.text;
}

function requireFailedDetails(
  details: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>["details"],
) {
  assert(details.status === "failed", `expected failed details, got ${details.status}`);
  return details;
}

function mockSpawn(exit: Partial<RunExit> = {}) {
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: input.runId ?? "call",
    pid: 1234,
    startedAtMs: Date.now(),
    wait: vi.fn(async () => createRunExit(exit)),
    cancel: vi.fn(),
  }));
}

function createBackendSandboxTool(
  params: {
    workspaceDir?: string;
    validateWorkdir?: BashSandboxConfig["validateWorkdir"];
    finalizeExec?: BashSandboxConfig["finalizeExec"];
    discardPreparedWorkdir?: BashSandboxConfig["discardPreparedWorkdir"];
    finalizeToken?: unknown;
  } = {},
) {
  const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(async (input) => ({
    argv: ["remote-shell", input.command],
    env: {},
    stdinMode: "pipe-open" as const,
    ...(params.finalizeToken === undefined ? {} : { finalizeToken: params.finalizeToken }),
  }));
  const validateWorkdir = vi.fn<NonNullable<BashSandboxConfig["validateWorkdir"]>>(
    params.validateWorkdir ?? (async (workdir) => workdir),
  );
  const tool = fullExec({
    host: "sandbox",
    sandbox: {
      containerName: "remote-sandbox-workdir-test",
      workspaceDir: params.workspaceDir ?? tempDirs.make("openclaw-sandbox-workdir-"),
      containerWorkdir: "/remote/workspace",
      workdirValidation: "backend",
      validateWorkdir,
      buildExecSpec,
      ...(params.finalizeExec ? { finalizeExec: params.finalizeExec } : {}),
      ...(params.discardPreparedWorkdir
        ? { discardPreparedWorkdir: params.discardPreparedWorkdir }
        : {}),
    },
  });
  return {
    buildExecSpec,
    tool,
    validateWorkdir,
    execute: (command = "echo ok", workdir = "/remote/workspace/generated") =>
      tool.execute("sandbox-workdir", { command, workdir }),
  };
}

async function expectUnavailableWorkdir(params: {
  workdir: string;
  toolDefaults?: Parameters<typeof createExecTool>[0];
  executeArgs?: Partial<Parameters<ReturnType<typeof createExecTool>["execute"]>[1]>;
}) {
  const tool = fullExec(params.toolDefaults);

  const executeArgs = params.executeArgs ?? { workdir: params.workdir };
  const result = await tool.execute("call-unavailable-workdir", {
    command: "echo should-not-run",
    ...executeArgs,
  });

  const text = requireTextContent(result);
  expect(text).toContain(`workdir "${params.workdir}" is unavailable or not a directory`);
  expect(text).toContain("command was not executed");
  expect(text).toContain("workdir is treated as a literal path");
  expect(text).toContain('shell expansions such as "~" are not applied');
  expect(requireFailedDetails(result.details)).toMatchObject({
    exitCode: null,
    timedOut: false,
    aggregated: "",
    cwd: params.workdir,
  });
  expect(supervisorMock.spawn).not.toHaveBeenCalled();
}

describe("exec foreground failures", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    envSnapshot = captureEnv(["SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
    supervisorMock.spawn.mockReset();
    supervisorMock.cancel.mockReset();
    supervisorMock.cancelScope.mockReset();
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot?.restore();
    envSnapshot = undefined;
    tempDirs.cleanup();
  });

  it("returns a failed text result when the default timeout is exceeded", async () => {
    const tool = fullExec({ timeoutSec: 1, backgroundMs: 10 });
    mockSpawn({
      reason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
      oomScoreWrapperSelected: true,
      timedOut: true,
    });

    const result = await tool.execute("call-timeout", {
      command: "echo never-runs",
      host: "gateway",
    });

    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn.mock.calls[0]?.[0]?.timeoutMs).toBe(1_000);
    const text = requireTextContent(result);
    expect(text).toMatch(/timed out/i);
    expect(text).toContain("external side effects may already have completed");
    expect(text).toContain("Verify the resulting state before retrying");
    expect(text).toContain("Do not automatically rerun commands unless repeating them is safe");
    expect(text).toContain("known to be safe to retry");
    expect(text).not.toMatch(/process|background|yieldMs|poll|trailing &/i);
    expect(text).not.toContain("OOM-score wrapper");
    expect(text).not.toContain("OPENCLAW_CHILD_OOM_SCORE_ADJ");
    const details = requireFailedDetails(result.details);
    expect(details).toMatchObject({
      exitCode: null,
      exitSignal: "SIGKILL",
      failureKind: "overall-timeout",
      exitReason: "overall-timeout",
      timedOut: true,
      noOutputTimedOut: false,
      aggregated: "",
    });
    expect(details.durationMs).toBeTypeOf("number");
    expect(details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("adds cautious Linux OOM guidance for a wrapped PTY signal 9", async () => {
    mockSpawn({
      reason: "signal",
      exitCode: 0,
      exitSignal: 9,
      oomScoreWrapperSelected: true,
    });
    const tool = fullExec();

    const result = await tool.execute("call-oom-9", {
      command: "find . -type f",
      host: "gateway",
      pty: true,
    });

    expect(supervisorMock.spawn.mock.calls[0]?.[0]?.mode).toBe("pty");
    const text = requireTextContent(result);
    for (const fragment of [
      "Command aborted by signal 9",
      "OpenClaw selected its Linux OOM-score wrapper",
      "attempts to set this child's oom_score_adj to 1000",
      "SIGKILL alone does not identify whether the Linux OOM killer",
      "Check cgroup memory events or kernel logs",
      "If they show memory pressure, narrow the command",
      "adjust memory, concurrency, or resource limits",
    ]) {
      expect(text).toContain(fragment);
    }
    expect(text).not.toContain("OPENCLAW_CHILD_OOM_SCORE_ADJ");
  });

  it.each(["gateway", "sandbox"] as const)(
    "returns a failed result for unavailable explicit %s workdirs before launching",
    async (host) => {
      const workspaceDir = tempDirs.make("openclaw-workdir-");
      fs.writeFileSync(path.join(workspaceDir, "not-dir"), "not a directory");
      const resolve = (name: string) =>
        host === "sandbox" ? `/workspace/${name}` : path.join(workspaceDir, name);
      const workdirs = [resolve("missing"), "   ", resolve("not-dir")];
      if (host === "sandbox") {
        workdirs.push(tempDirs.make("openclaw-outside-workdir-"));
      }
      for (const workdir of workdirs) {
        await expectUnavailableWorkdir({
          workdir,
          toolDefaults:
            host === "gateway"
              ? undefined
              : {
                  host,
                  sandbox: {
                    containerName: "sandbox-workdir-test",
                    workspaceDir,
                    containerWorkdir: "/workspace",
                  },
                },
        });
        supervisorMock.spawn.mockClear();
      }
    },
  );

  it("returns a failed result when the current gateway cwd is unavailable", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("current cwd unavailable");
    });
    try {
      await expectUnavailableWorkdir({
        workdir: "current working directory",
        executeArgs: {},
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it.each([true, false])(
    "explains sandbox PTY downgrades only when requested (pty=%s)",
    async (pty) => {
      const { tool } = createBackendSandboxTool();
      mockSpawn();

      const result = await tool.execute("sandbox-pty", { command: "echo ok", pty });

      expect(result.details.status).toBe("completed");
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
      expect(supervisorMock.spawn.mock.calls[0]?.[0]?.mode).toBe("child");
      const text = requireTextContent(result);
      if (pty) {
        expect(text).toContain("Warning: PTY is unavailable in sandbox mode");
        expect(text).toContain("running without a PTY. Use a noninteractive command");
      } else {
        expect(text).not.toMatch(/PTY/i);
      }
    },
  );

  it("finalizes backend sandbox exec tokens when process spawn fails", async () => {
    const finalizeToken = { session: "remote-session" };
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const { buildExecSpec, execute, validateWorkdir } = createBackendSandboxTool({
      finalizeExec,
      finalizeToken,
    });
    supervisorMock.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(execute()).rejects.toThrow("spawn failed");

    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
    expect(buildExecSpec).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: finalizeToken,
    });
  });

  it("rejects unsafe commands before backend workdir validation", async () => {
    const discardPreparedWorkdir =
      vi.fn<NonNullable<BashSandboxConfig["discardPreparedWorkdir"]>>();
    const { buildExecSpec, execute, validateWorkdir } = createBackendSandboxTool({
      discardPreparedWorkdir,
    });
    await expect(execute("/approve approval-1 deny")).rejects.toThrow(
      "exec cannot run /approve commands",
    );

    expect(validateWorkdir).not.toHaveBeenCalled();
    expect(discardPreparedWorkdir).not.toHaveBeenCalled();
    expect(buildExecSpec).not.toHaveBeenCalled();
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("uses the mapped host cwd for existing relative backend-validated sandbox workdirs", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workdir-");
    const srcDir = path.join(workspaceDir, "src");
    fs.mkdirSync(srcDir);
    const { buildExecSpec, execute, validateWorkdir } = createBackendSandboxTool({ workspaceDir });
    mockSpawn();

    const result = await execute("echo ok", "src");
    expect(result.details).toMatchObject({ status: "completed", cwd: srcDir });
    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/src");
    expect(buildExecSpec).toHaveBeenCalledOnce();
    expect(buildExecSpec.mock.calls[0]?.[0]?.workdir).toBe("/remote/workspace/src");
    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn.mock.calls[0]?.[0]?.cwd).toBe(srcDir);
  });

  it("fails backend-validated sandbox workdirs before launch when backend validation rejects", async () => {
    const { buildExecSpec, execute, validateWorkdir } = createBackendSandboxTool({
      validateWorkdir: async () => null,
    });
    const result = await execute();

    expect(result.details).toMatchObject({
      status: "failed",
      cwd: "/remote/workspace/generated",
    });
    expect(JSON.stringify(result)).toContain("unavailable or not a directory");
    expect(validateWorkdir).toHaveBeenCalledOnce();
    expect(buildExecSpec).not.toHaveBeenCalled();
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });
});
