import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { pathLooksMutableForShellPayloadSync } from "../infra/system-run-mutable-file-policy.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { callGatewayTool } from "./tools/gateway.js";

const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe.skipIf(process.platform === "win32")("gateway dispatch executable binding", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let root: string;
  let binDir: string;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "PATH",
      "SHELL",
    ]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatch-binding-"));
    binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
      setTestEnvValue(name, root);
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin`);
    setTestEnvValue("SHELL", "/bin/sh");
    resetProcessRegistryForTests();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    vi.mocked(callGatewayTool).mockReset();
    // Substitution cases never dispatch fixture files, including on the unfixed code.
    spawn.mockReset().mockImplementation(async () => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: "recorded-spawn",
      startedAtMs: Date.now(),
      cancel: () => {},
      wait: async () => ({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    }));
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeTool(mode: "auto" | "ask", autoReviewer: ExecAutoReviewer) {
    return createExecTool({
      agentId: "main",
      host: "gateway",
      mode,
      safeBins: [],
      autoReviewer,
      cwd: root,
      pathPrepend: [binDir, "/usr/bin", "/bin"],
      runId: "dispatch-binding-run",
      messageProvider: "webchat",
    });
  }

  it.each([
    { approval: "auto", executable: "env", command: "env ls *.txt" },
    { approval: "auto", executable: "ls", command: "env ls *.txt" },
    { approval: "auto", executable: "ls", command: "ls *.txt" },
    { approval: "human", executable: "env", command: "env ls *.txt" },
    { approval: "human", executable: "ls", command: "env ls *.txt" },
  ] as const)(
    "rejects real PATH substitution of $executable after $approval approval of $command before spawn",
    async ({ approval, executable, command }) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      for (const executableName of ["env", "ls"]) {
        const resolved = resolveExecutablePath(executableName, {
          env: process.env,
          useCache: false,
        });
        expect(resolved).toBeDefined();
        expect(pathLooksMutableForShellPayloadSync(resolved ?? "")).toBe(false);
      }
      const replacement = path.join(binDir, executable);
      const substitute = () => fs.writeFileSync(replacement, "", { mode: 0o755 });
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "list fixture files",
      }));
      let approved = false;
      const unsubscribe = onAgentEvent((event) => {
        if (
          approval === "auto" &&
          event.runId === "dispatch-binding-run" &&
          event.data.approvalReviewOutcome === "approved"
        ) {
          approved = true;
          substitute();
        }
      });
      vi.mocked(callGatewayTool).mockImplementation(async (method) => {
        if (method === "exec.approval.request") {
          return { status: "accepted", id: "dispatch-binding-approval" };
        }
        if (method === "exec.approval.waitDecision") {
          approved = true;
          substitute();
          return { decision: "allow-once" };
        }
        return { ok: true };
      });
      const tool = makeTool(approval === "auto" ? "auto" : "ask", autoReviewer);
      try {
        const result = await tool.execute("dispatch-binding-call", { command });
        expect(approved).toBe(true);
        expect(resolveExecutablePath(executable, { env: process.env, useCache: false })).toBe(
          replacement,
        );
        expect(spawn.mock.calls.length).toBe(0);
        expect(result.details.status).toBe("failed");
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("approval script operand changed before execution"),
        });
        if (approval === "auto") {
          expect(autoReviewer).toHaveBeenCalledOnce();
          expect(callGatewayTool).not.toHaveBeenCalled();
        } else {
          expect(autoReviewer).not.toHaveBeenCalled();
          expect(callGatewayTool).toHaveBeenCalledWith(
            "exec.approval.waitDecision",
            expect.anything(),
            expect.objectContaining({ id: expect.any(String) }),
          );
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["env ls *.txt", "ls *.txt"])(
    "really executes approved unpinned %s and returns stdout without substitution",
    async (command) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      const supervisor = createProcessSupervisor();
      spawn.mockImplementation((input) => supervisor.spawn(input));
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "list fixture files",
      }));
      const result = await makeTool("auto", autoReviewer).execute("dispatch-positive-call", {
        command,
      });
      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({ command, reason: "execution-plan-miss" }),
      );
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(spawn.mock.calls.length).toBe(1);
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("approved.txt") });
    },
  );

  it.each([
    "env FOO=bar ls *.txt",
    "sh -c 'ls *.txt'",
    "xcrun ls *.txt",
    "command ls *.txt",
    "exec ls *.txt",
    "builtin echo *.txt",
  ])("routes unbindable dispatch %s to human approval without auto-review", async (command) => {
    fs.copyFileSync("/usr/bin/true", path.join(binDir, "xcrun"));
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "would approve if called",
    }));
    const recordedSpawn = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      fs.writeFileSync(path.join(root, "spawn-marker"), "recorded");
      return recordedSpawn(...args);
    });
    vi.mocked(callGatewayTool).mockImplementation(async () => {
      fs.writeFileSync(path.join(binDir, "ls"), "", { mode: 0o755 });
      return { decision: "deny" };
    });
    const result = await makeTool("auto", autoReviewer).execute("dispatch-human-call", {
      command,
    });
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(callGatewayTool).toHaveBeenCalledWith(
      "exec.approval.request",
      expect.anything(),
      expect.objectContaining({
        command,
        warningText: expect.stringContaining(
          "Exec auto-review skipped: dispatch chain cannot be bound",
        ),
      }),
      expect.anything(),
    );
    expect(result.details.status).toBe("failed");
    expect(spawn.mock.calls.length).toBe(0);
    expect(fs.existsSync(path.join(root, "spawn-marker"))).toBe(false);
  });

  it.each(["busybox", "toybox"])(
    "retains opaque interpreter rejection for %s shell applets with a resolved binary",
    async (wrapper) => {
      const wrapperPath = path.join(binDir, wrapper);
      fs.copyFileSync("/usr/bin/true", wrapperPath);
      expect(resolveExecutablePath(wrapper, { env: process.env, useCache: false })).toBe(
        wrapperPath,
      );
      const autoReviewer = vi.fn<ExecAutoReviewer>();
      const result = await makeTool("auto", autoReviewer).execute("dispatch-opaque-call", {
        command: `${wrapper} sh -c 'ls *.txt'`,
      });
      expect(result.details.status).toBe("failed");
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(
          "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        ),
      });
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(spawn.mock.calls.length).toBe(0);
    },
  );

  it.each(["busybox", "toybox"])(
    "retains binding rejection for missing %s dispatch files",
    async (wrapper) => {
      const autoReviewer = vi.fn<ExecAutoReviewer>();
      const result = await makeTool("auto", autoReviewer).execute("dispatch-unresolved-call", {
        command: `${path.join(root, "missing", wrapper)} ls *.txt`,
      });
      expect(result.details.status).toBe("failed");
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("SYSTEM_RUN_DENIED"),
      });
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(spawn.mock.calls.length).toBe(0);
    },
  );
});
