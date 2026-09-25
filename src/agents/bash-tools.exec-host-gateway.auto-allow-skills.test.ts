import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
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

describe.skipIf(process.platform === "win32")("gateway-host exec autoAllowSkills", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let root: string;
  let binDir: string;
  let workspace: string;

  beforeEach(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "PATH",
      "SHELL",
    ]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-skill-bins-"));
    binDir = path.join(root, "bin");
    workspace = path.join(root, "workspace");
    fs.mkdirSync(binDir);
    for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
      setTestEnvValue(name, root);
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin`);
    setTestEnvValue("SHELL", "/bin/sh");
    for (const bin of ["skill-tool", "other-tool", "undeclared-tool"]) {
      fs.copyFileSync("/usr/bin/true", path.join(binDir, bin));
    }
    await writeSkill({
      dir: path.join(workspace, "skills", "skill-tool"),
      name: "skill-tool",
      description: "Runs the skill tool",
      metadata: '{"openclaw":{"requires":{"bins":["skill-tool"]}}}',
    });
    await writeSkill({
      dir: path.join(workspace, "skills", "disabled-skill"),
      name: "disabled-skill",
      description: "A skill turned off in config",
      metadata: '{"openclaw":{"requires":{"bins":["other-tool"]}}}',
    });
    resetProcessRegistryForTests();
    vi.mocked(callGatewayTool).mockReset();
    spawn.mockReset().mockImplementation(async () => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: "skill-bins-spawn",
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

  function run(autoAllowSkills: boolean, command: string, env?: Record<string, string>) {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: { main: { autoAllowSkills, allowlist: [] } },
    });
    const config = {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace } } },
      skills: { entries: { "disabled-skill": { enabled: false } } },
    } satisfies OpenClawConfig;
    const tool = createExecTool({
      agentId: "main",
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      config,
      cwd: root,
      pathPrepend: [binDir, "/usr/bin", "/bin"],
      runId: "skill-bins-run",
      messageProvider: "webchat",
    });
    return tool.execute("skill-bins-call", env ? { command, env } : { command });
  }

  it("runs a workspace skill's declared bin when autoAllowSkills is on", async () => {
    const result = await run(true, "skill-tool");
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(spawn).toHaveBeenCalledOnce();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("still denies the skill bin when autoAllowSkills is off", async () => {
    await expect(run(false, "skill-tool")).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still denies a bin only a disabled skill declares", async () => {
    await expect(run(true, "other-tool")).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still denies a bin no skill declares when autoAllowSkills is on", async () => {
    await expect(run(true, "undeclared-tool")).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  // Skill bins resolve on the command's PATH, which is safe only because host exec refuses a
  // requested PATH; this pins that invariant.
  it("refuses a requested PATH that would reach a planted skill-named binary", async () => {
    const planted = path.join(root, "planted");
    fs.mkdirSync(planted);
    fs.copyFileSync("/usr/bin/true", path.join(planted, "skill-tool"));
    await expect(run(true, "skill-tool", { PATH: `${planted}:/usr/bin:/bin` })).rejects.toThrow(
      "Custom 'PATH' variable is forbidden during host execution",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
