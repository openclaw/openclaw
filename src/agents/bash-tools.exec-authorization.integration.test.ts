import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadExecApprovalsReadOnly, saveExecApprovals } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { callGatewayTool } from "./tools/gateway.js";

// Execution spy arguments contain inherited environment; assert only scalar projections.
const boundary = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  prepare: vi.fn<() => Promise<void>>(),
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: boundary.spawn }),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));
vi.mock("./shell-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell-snapshot.js")>();
  return {
    ...actual,
    maybeWrapCommandWithShellSnapshot: async (
      ...args: Parameters<typeof actual.maybeWrapCommandWithShellSnapshot>
    ) => {
      await boundary.prepare();
      return actual.maybeWrapCommandWithShellSnapshot(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const python3 = resolveExecutablePath("python3", { useCache: false });

describe.skipIf(process.platform === "win32")("gateway execution authorization boundary", () => {
  let root: string;
  let envSnapshot: ReturnType<typeof captureEnv>;
  let supervisor: ReturnType<typeof createProcessSupervisor> | undefined;
  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "PATH",
      "SHELL",
      "ZDOTDIR",
      "OPENCLAW_EXEC_SHELL_SNAPSHOT",
    ]);
    root = fs.realpathSync(tempDirs.make("exec-authorization-boundary-"));
    for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "ZDOTDIR"]) {
      setTestEnvValue(key, root);
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setTestEnvValue("PATH", "/usr/bin:/bin");
    setTestEnvValue("SHELL", "/bin/bash");
    setTestEnvValue("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    resetProcessRegistryForTests();
    boundary.prepare.mockReset().mockResolvedValue(undefined);
    const liveSupervisor = createProcessSupervisor();
    supervisor = liveSupervisor;
    boundary.spawn.mockReset().mockImplementation((input) => liveSupervisor.spawn(input));
    vi.mocked(callGatewayTool).mockReset();
  });
  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });
  function tool(
    autoReviewer: ExecAutoReviewer,
    mode: "auto" | "ask" | "allowlist" | "full" = "auto",
    pathPrepend?: string[],
  ) {
    return createExecTool({
      agentId: "main",
      host: "gateway",
      mode,
      pathPrepend,
      safeBins: [],
      autoReviewer,
      cwd: root,
      runId: "boundary-probe-run",
      messageProvider: "webchat",
      nonInteractiveApproval: mode === "auto",
      notifyOnExit: false,
    });
  }
  function reviewer() {
    return vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "list fixture files",
    }));
  }

  function setPolicy(security: "allowlist" | "deny", allowlisted = false) {
    saveExecApprovals({
      version: 1,
      defaults: { security, ask: security === "deny" ? "off" : "on-miss", askFallback: "deny" },
      agents: allowlisted ? { main: { allowlist: [{ pattern: "/bin/ls" }] } } : {},
    });
  }

  for (const shell of ["/bin/bash", "/bin/zsh"]) {
    it
      .skipIf(!fs.existsSync(shell))
      .each(["ls *.txt", "env ls *.txt", "env -- env ls ~/approved.txt | cat && ls *.txt"])(
      `executes bound globs and chains without startup substitutions in ${shell}: %s`,
      async (command) => {
        setTestEnvValue("SHELL", shell);
        fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
        fs.writeFileSync(
          path.join(root, shell.endsWith("bash") ? ".bashrc" : ".zshrc"),
          [
            "ls() { printf 'UNREVIEWED_FUNCTION\\n'; }",
            "env() { printf 'UNREVIEWED_WRAPPER\\n'; }",
            "alias cat=false",
            "export PATH=/unreviewed-path",
            "",
          ].join("\n"),
        );
        const review = reviewer();
        const result = await tool(review).execute("bound-dispatch", { command });
        if (result.details.status !== "completed") {
          throw new Error(`Unexpected exec status: ${result.details.status}`);
        }
        expect(review.mock.calls.length).toBe(1);
        expect(review.mock.calls[0]?.[0].command).toBe(command);
        expect(vi.mocked(callGatewayTool).mock.calls.length).toBe(0);
        expect(result.details.exitCode).toBe(0);
        expect(result.details.aggregated).toContain("approved.txt");
        expect(result.details.aggregated).not.toContain("UNREVIEWED");
        expect(boundary.spawn.mock.calls.length).toBe(1);
      },
    );
  }

  it.skipIf(!python3).each([
    { mode: "auto", command: "python probe.py *.txt", shadowed: false },
    { mode: "auto", command: "python probe.py *.txt", shadowed: true },
    { mode: "auto", command: "python probe.py approved.txt", shadowed: false },
    { mode: "ask", command: "python probe.py approved.txt", shadowed: false },
    { mode: "ask", command: "python probe.py approved.txt", shadowed: true },
    { mode: "ask", command: "env python probe.py approved.txt", shadowed: false },
  ] as const)(
    "preserves the $mode virtualenv invocation or rejects PATH drift: $command (shadowed=$shadowed)",
    async ({ mode, command, shadowed }) => {
      if (!python3) {
        throw new Error("Python is required for this virtualenv regression");
      }
      const venv = path.join(root, "venv");
      const env = { HOME: root, PATH: "/usr/bin:/bin", PYTHONNOUSERSITE: "1" };
      execFileSync(python3, ["-m", "venv", "--without-pip", "--symlinks", venv], { env });
      const interpreter = path.join(venv, "bin", "python");
      expect(fs.lstatSync(interpreter).isSymbolicLink()).toBe(true);
      const sitePackages = execFileSync(
        interpreter,
        ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        { env, encoding: "utf8" },
      ).trim();
      if (!sitePackages.startsWith(`${venv}${path.sep}`)) {
        throw new Error("The fixture must not write outside its virtualenv");
      }
      fs.writeFileSync(
        path.join(sitePackages, "venv_fixture.py"),
        "VALUE = 'venv-package-loaded'\n",
      );
      fs.writeFileSync(
        path.join(root, "probe.py"),
        "import sys, venv_fixture; print(venv_fixture.VALUE, *sys.argv[1:])\n",
      );
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      expect(
        execFileSync(interpreter, ["probe.py", "approved.txt"], {
          cwd: root,
          env,
          encoding: "utf8",
        }).trim(),
      ).toBe("venv-package-loaded approved.txt");
      const earlierBin = path.join(root, "earlier-bin");
      fs.mkdirSync(earlierBin);
      const review = reviewer();
      if (shadowed && mode === "auto") {
        review.mockImplementation(async () => {
          fs.symlinkSync(fs.realpathSync(interpreter), path.join(earlierBin, "python"));
          return { decision: "allow-once", risk: "low", rationale: "list fixture files" };
        });
      }
      if (mode === "ask") {
        vi.mocked(callGatewayTool).mockImplementation(async (method) => {
          if (method === "exec.approval.request") {
            return { status: "accepted", id: "venv-approval" };
          }
          if (method === "exec.approval.waitDecision") {
            if (shadowed) {
              fs.symlinkSync(fs.realpathSync(interpreter), path.join(earlierBin, "python"));
            }
            return { decision: "allow-once" };
          }
          return { ok: true };
        });
      }
      // Gateway login-shell PATH is cached; select the fixture through its explicit exec setting.
      const result = await tool(review, mode, [earlierBin, path.dirname(interpreter)]).execute(
        "venv-review",
        { command },
      );
      expect(review.mock.calls.length).toBe(mode === "auto" ? 1 : 0);
      expect(
        vi
          .mocked(callGatewayTool)
          .mock.calls.filter(([method]) => method === "exec.approval.waitDecision").length,
      ).toBe(mode === "ask" ? 1 : 0);
      if (shadowed) {
        expect(result.details.status).toBe("failed");
        expect(boundary.spawn.mock.calls.length).toBe(0);
        return;
      }
      if (result.details.status !== "completed") {
        throw new Error(`Unexpected exec status: ${result.details.status}`);
      }
      expect(result.details.exitCode).toBe(0);
      expect(result.details.aggregated).toBe("venv-package-loaded approved.txt");
    },
  );

  it("keeps current-policy execution pinned when an allowlisted symlink changes", async () => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const commandPath = path.join(bin, "read-approved");
    fs.symlinkSync("/bin/cat", commandPath);
    fs.writeFileSync(path.join(root, "approved.txt"), "approved-content\n");
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: { main: { allowlist: [{ pattern: fs.realpathSync("/bin/cat") }] } },
    });
    boundary.prepare.mockImplementation(async () => {
      fs.unlinkSync(commandPath);
      fs.symlinkSync("/bin/echo", commandPath);
    });
    const review = reviewer();

    const result = await tool(review, "allowlist", [bin]).execute("allowlist-symlink", {
      command: "read-approved approved.txt",
    });

    expect(review.mock.calls.length).toBe(0);
    expect(vi.mocked(callGatewayTool).mock.calls.length).toBe(0);
    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.exitCode).toBe(0);
    expect(result.details.aggregated).toBe("approved-content");
  });

  it("preserves startup customization for ordinary full-mode execution", async () => {
    setPolicy("allowlist");
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    fs.writeFileSync(path.join(root, ".bashrc"), "ls() { printf 'CUSTOMIZED\\n'; }\n");
    const review = reviewer();
    const result = await tool(review, "full").execute("full-customization", {
      command: "ls *.txt",
    });
    expect(review.mock.calls.length).toBe(0);
    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.aggregated).toBe("CUSTOMIZED");
  });

  for (const authority of ["auto", "human-once", "human-always", "current-policy"] as const) {
    it.each([false, true])(
      `revalidates ${authority} after asynchronous shell preparation (revoked=%s)`,
      async (revoked) => {
        setTestEnvValue("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
        fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
        setPolicy("allowlist", authority === "current-policy");
        const review = reviewer();
        vi.mocked(callGatewayTool).mockImplementation(async (method) => {
          if (method === "exec.approval.request") {
            return { status: "accepted", id: "fixture-approval" };
          }
          if (method === "exec.approval.waitDecision") {
            return { decision: authority === "human-always" ? "allow-always" : "allow-once" };
          }
          return { ok: true };
        });
        if (revoked) {
          boundary.prepare.mockImplementation(async () => setPolicy("deny"));
        }
        const mode =
          authority === "current-policy" ? "allowlist" : authority === "auto" ? "auto" : "ask";
        const pending = tool(review, mode).execute("policy-revalidation", {
          command: "/bin/ls approved.txt",
        });
        if (revoked) {
          await expect(pending).rejects.toThrow("Exec approval changed before execution");
          expect(boundary.spawn.mock.calls.length).toBe(0);
        } else {
          const result = await pending;
          if (result.details.status !== "completed") {
            throw new Error(`Unexpected exec status: ${result.details.status}`);
          }
          expect(result.details.exitCode).toBe(0);
          expect(result.details.aggregated).toBe("approved.txt");
          expect(boundary.spawn.mock.calls.length).toBe(1);
        }
        expect(review.mock.calls.length).toBe(authority === "auto" ? 1 : 0);
        expect(boundary.prepare.mock.calls.length).toBe(1);
        expect(loadExecApprovalsReadOnly().defaults?.security).toBe(revoked ? "deny" : "allowlist");
      },
    );
  }

  it("rechecks policy after deferred supervisor admission", async () => {
    let started = 0;
    const liveSupervisor = supervisor!;
    boundary.spawn.mockImplementation(async (input) => {
      await Promise.resolve();
      setPolicy("deny");
      const run = await liveSupervisor.spawn(input);
      started += 1;
      return run;
    });
    await expect(
      tool(reviewer()).execute("deferred-admission", { command: "/bin/ls" }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(started).toBe(0);
  });

  it.each([false, true])(
    "preserves human allow-always through PTY fallback (revoked=%s)",
    async (revoked) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      vi.mocked(callGatewayTool).mockImplementation(async (method) =>
        method === "exec.approval.request"
          ? { status: "accepted", id: "fixture-pty-approval" }
          : { decision: "allow-always" },
      );
      const liveSupervisor = supervisor!;
      let started = 0;
      boundary.spawn.mockImplementation(async (input) => {
        if (input.mode === "pty") {
          if (revoked) {
            setPolicy("deny");
          }
          throw new Error("fixture PTY unavailable");
        }
        const run = await liveSupervisor.spawn(input);
        started += 1;
        return run;
      });
      const pending = tool(reviewer(), "ask").execute("pty-revalidation", {
        command: "/bin/ls approved.txt",
        pty: true,
      });
      if (revoked) {
        await expect(pending).rejects.toThrow("Exec approval changed before execution");
        expect(started).toBe(0);
      } else {
        const result = await pending;
        if (result.details.status !== "completed") {
          throw new Error(`Unexpected exec status: ${result.details.status}`);
        }
        expect(result.details.aggregated).toBe("approved.txt");
        expect(started).toBe(1);
        expect((loadExecApprovalsReadOnly().agents?.main?.allowlist ?? []).length).toBeGreaterThan(
          0,
        );
      }
    },
  );
});
