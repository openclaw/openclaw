import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecSkillScope } from "./bash-tools.exec-types.js";
import { callGatewayTool } from "./tools/gateway.js";

const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
const sendFollowup = vi.hoisted(() => vi.fn(async (_target: unknown, _text: string) => {}));
// mock-isolation: no child process is started; the spawn spy records whether launch was reached.
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
// mock-isolation: approval RPCs use a synthetic Gateway peer; no live Gateway is contacted.
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));
// Follow-up delivery is the only seam on the detached path; approval, launch and the spawn
// boundary run for real.
vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>()),
  sendExecApprovalFollowupResult: sendFollowup,
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
    sendFollowup.mockClear();
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

  function saveApprovals(autoAllowSkills: boolean) {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: { main: { autoAllowSkills, allowlist: [] } },
    });
  }

  function buildConfig() {
    return {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace } } },
      skills: { entries: { "disabled-skill": { enabled: false } } },
    } satisfies OpenClawConfig;
  }

  function run(
    autoAllowSkills: boolean,
    command: string,
    options?: { env?: Record<string, string>; skillScope?: ExecSkillScope },
  ) {
    saveApprovals(autoAllowSkills);
    const tool = createExecTool({
      agentId: "main",
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      config: buildConfig(),
      cwd: root,
      pathPrepend: [binDir, "/usr/bin", "/bin"],
      runId: "skill-bins-run",
      messageProvider: "webchat",
      ...(options?.skillScope ? { skillScope: options.skillScope } : {}),
    });
    return tool.execute(
      "skill-bins-call",
      options?.env ? { command, env: options.env } : { command },
    );
  }

  function runGatewayAllowlist(ask: "off" | "always", extra?: { approvalFollowupMode: "agent" }) {
    return processGatewayAllowlist({
      command: "skill-tool",
      workdir: root,
      env: { PATH: `${binDir}:/usr/bin:/bin` },
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask,
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      agentId: "main",
      config: buildConfig(),
      ...extra,
    });
  }

  // Uninstall the authorizing skill, as the skills watcher would observe it.
  function uninstallSkillTool() {
    const skillDir = path.join(workspace, "skills", "skill-tool");
    fs.rmSync(skillDir, { recursive: true });
    bumpSkillsSnapshotVersion({ workspaceDir: workspace, reason: "watch", changedPath: skillDir });
  }

  function mockDetachedAllowOnce(onDecision?: () => void) {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
      agents: { main: { autoAllowSkills: true, allowlist: [] } },
    });
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "exec.approval.request") {
        return { status: "accepted" };
      }
      if (method === "exec.approval.waitDecision") {
        onDecision?.();
        return { decision: "allow-once" };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
  }

  // Repoint the trusted name at a different executable, as a skill upgrade or a planted
  // replacement would between authorization and spawn.
  function swapSkillBin() {
    const swapped = path.join(root, "swapped-tool");
    fs.copyFileSync("/usr/bin/true", swapped);
    fs.rmSync(path.join(binDir, "skill-tool"));
    fs.symlinkSync(swapped, path.join(binDir, "skill-tool"));
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

  // A reply can narrow its skills below the agent's config through the session filter or an
  // override. Bin trust must follow that narrower set, or an excluded skill still authorizes exec.
  it("still denies a skill bin the session filter excludes", async () => {
    await expect(
      run(true, "skill-tool", { skillScope: { skillFilter: ["disabled-skill"] } }),
    ).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still denies a skill bin a session override turns off", async () => {
    await expect(
      run(true, "skill-tool", { skillScope: { skillOverrides: { "skill-tool": false } } }),
    ).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the skill bin when the session filter keeps its skill", async () => {
    const result = await run(true, "skill-tool", { skillScope: { skillFilter: ["skill-tool"] } });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(spawn).toHaveBeenCalledOnce();
  });

  // Skill bins resolve by executable identity, and the approvals file records none, so the
  // committed-policy recheck cannot see the authorizing binary being swapped while approval
  // settles. The spawn boundary must, before the process can do any I/O.
  it("denies at the spawn boundary when the authorizing skill bin is swapped", async () => {
    saveApprovals(true);
    const result = await runGatewayAllowlist("off");
    expect(result.deniedResult).toBeUndefined();
    expect(result.revalidateBeforeExecution).toBeTypeOf("function");

    swapSkillBin();

    const denied = await result.revalidateBeforeExecution?.();
    expect(denied?.details).toMatchObject({
      status: "failed",
      exitCode: null,
      aggregated: expect.stringContaining(
        "SYSTEM_RUN_DENIED: skill bin authorization changed before execution",
      ),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  // A detached approval settles long after evaluation and launches from its own callback. With
  // ask "always", a skill-authorized command must still launch while trust holds, and must not
  // reach spawn once the authorizing skill is removed while the approval is pending: the
  // executable is unchanged, so only the skill-authority recheck can catch it.
  it.each([
    { name: "launches when skill trust still holds", withdraw: false },
    { name: "denies before spawn when skill trust is withdrawn", withdraw: true },
  ])("detached approval launch $name", async ({ withdraw }) => {
    mockDetachedAllowOnce(withdraw ? uninstallSkillTool : undefined);

    const result = await runGatewayAllowlist("always", { approvalFollowupMode: "agent" });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => expect(sendFollowup).toHaveBeenCalled(), { timeout: 10_000 });
    const followup = String(sendFollowup.mock.calls.at(-1)?.[1]);
    if (withdraw) {
      expect(followup).toContain("skill bin authorization changed before execution");
      expect(spawn).not.toHaveBeenCalled();
    } else {
      expect(followup).toContain("Exec finished");
      expect(spawn).toHaveBeenCalledOnce();
    }
  });

  // After the spawn preflight, the supervisor can still wait on a scope fence or adapter
  // preparation. Trust withdrawn there must stop the detached launch at native initiation.
  it("detached approval launch denies at native initiation when trust is withdrawn after preflight", async () => {
    mockDetachedAllowOnce();
    const launch = vi.fn();
    spawn.mockImplementationOnce(async (input) => {
      uninstallSkillTool();
      input.initiateSpawn?.(launch);
      throw new Error("native initiation was not refused");
    });

    const result = await runGatewayAllowlist("always", { approvalFollowupMode: "agent" });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => expect(sendFollowup).toHaveBeenCalled(), { timeout: 10_000 });
    expect(String(sendFollowup.mock.calls.at(-1)?.[1])).toContain(
      "skill bin authorization changed before execution",
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });

  // Skill bins resolve on the command's PATH, which is safe only because host exec refuses a
  // requested PATH; this pins that invariant.
  it("refuses a requested PATH that would reach a planted skill-named binary", async () => {
    const planted = path.join(root, "planted");
    fs.mkdirSync(planted);
    fs.copyFileSync("/usr/bin/true", path.join(planted, "skill-tool"));
    await expect(
      run(true, "skill-tool", { env: { PATH: `${planted}:/usr/bin:/bin` } }),
    ).rejects.toThrow("Custom 'PATH' variable is forbidden during host execution");
    expect(spawn).not.toHaveBeenCalled();
  });
});
