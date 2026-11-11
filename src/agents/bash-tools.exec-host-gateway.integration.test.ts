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
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { callGatewayTool } from "./tools/gateway.js";

const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
const autoReviewer = vi.fn<ExecAutoReviewer>();
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe.skipIf(process.platform === "win32")("gateway dispatch executable binding", () => {
  let root: string;
  let binDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatch-binding-"));
    binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
      vi.stubEnv(name, root);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("PATH", `${binDir}:/usr/bin:/bin`);
    vi.stubEnv("SHELL", "/bin/sh");
    resetProcessRegistryForTests();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    vi.mocked(callGatewayTool).mockReset();
    autoReviewer.mockReset().mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "list fixture files",
    });
    // Substitution cases never dispatch fixture files, including on the unfixed code.
    spawn.mockReset().mockImplementation(async (input) => runtimeManagedRun(input));
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeTool(mode: "auto" | "ask") {
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
      let approved = false;
      const substitute = () => {
        approved = true;
        fs.writeFileSync(replacement, "", { mode: 0o755 });
      };
      const unsubscribe = onAgentEvent((event) => {
        if (
          approval === "auto" &&
          event.runId === "dispatch-binding-run" &&
          event.data.approvalReviewOutcome === "approved"
        ) {
          substitute();
        }
      });
      vi.mocked(callGatewayTool).mockImplementation(async (method) => {
        if (method === "exec.approval.request") {
          return { status: "accepted", id: "dispatch-binding-approval" };
        }
        if (method === "exec.approval.waitDecision") {
          substitute();
          return { decision: "allow-once" };
        }
        return { ok: true };
      });
      const result = await makeTool(approval === "auto" ? "auto" : "ask")
        .execute("dispatch-binding-call", { command })
        .finally(unsubscribe);
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
    },
  );

  it("routes unbindable dispatch to human approval without auto-review", async () => {
    const command = "env FOO=bar ls *.txt";
    vi.mocked(callGatewayTool).mockImplementation(async () => {
      fs.writeFileSync(path.join(binDir, "ls"), "", { mode: 0o755 });
      return { decision: "deny" };
    });
    const result = await makeTool("auto").execute("dispatch-human-call", {
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
  });

  it.each([
    [
      "busybox sh -c 'ls *.txt'",
      true,
      "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    ],
    ["ls *.txt", false, "SYSTEM_RUN_DENIED"],
  ] as const)("rejects %s before review or dispatch", async (command, resolved, error) => {
    const wrapperPath = path.join(resolved ? binDir : path.join(root, "missing"), "busybox");
    if (resolved) {
      fs.copyFileSync("/usr/bin/true", wrapperPath);
      expect(resolveExecutablePath("busybox", { env: process.env, useCache: false })).toBe(
        wrapperPath,
      );
    }
    const result = await makeTool("auto").execute("dispatch-unresolved-call", {
      command: resolved ? command : `${wrapperPath} ${command}`,
    });
    expect(result.details.status).toBe("failed");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(error) });
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(spawn.mock.calls.length).toBe(0);
  });
});
