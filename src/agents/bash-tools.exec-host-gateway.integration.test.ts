import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { pathLooksMutableForShellPayloadSync } from "../infra/system-run-mutable-file-policy.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
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
      wait: async () => createRunExit({ durationMs: 0 }),
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

  it("routes unbindable dispatch to human approval without auto-review", async () => {
    const command = "env FOO=bar ls *.txt";
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

  it.each([
    {
      name: "opaque interpreter",
      command: "busybox sh -c 'ls *.txt'",
      resolved: true,
      error: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    },
    {
      name: "missing dispatch file",
      command: "ls *.txt",
      resolved: false,
      error: "SYSTEM_RUN_DENIED",
    },
  ])("rejects $name before review or dispatch", async ({ command, resolved, error }) => {
    const wrapperPath = path.join(resolved ? binDir : path.join(root, "missing"), "busybox");
    if (resolved) {
      fs.copyFileSync("/usr/bin/true", wrapperPath);
      expect(resolveExecutablePath("busybox", { env: process.env, useCache: false })).toBe(
        wrapperPath,
      );
    }
    const autoReviewer = vi.fn<ExecAutoReviewer>();
    const result = await makeTool("auto", autoReviewer).execute("dispatch-unresolved-call", {
      command: resolved ? command : `${wrapperPath} ${command}`,
    });
    expect(result.details.status).toBe("failed");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(error) });
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(spawn.mock.calls.length).toBe(0);
  });
});
