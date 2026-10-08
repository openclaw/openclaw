import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { ExecProcessPreflightError } from "./bash-tools.exec-launch.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

const launchWait = vi.hoisted(() => ({ during: undefined as (() => void) | undefined }));
const registerEgress = vi.hoisted(() =>
  vi.fn(async () => {
    launchWait.during?.();
    return { env: {}, revoke: () => {} };
  }),
);
// Secret-egress registration is one of the awaits between the spawn preflight and native
// initiation; it is the seam where trust is withdrawn. The supervisor, child adapter and native
// launch stay real, so a marker file records whether the command ever ran.
vi.mock("../secrets/egress-proxy/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/egress-proxy/registry.js")>()),
  registerSecretEgressProxyProcess: registerEgress,
}));

describe.skipIf(process.platform === "win32")(
  "gateway skill authority at native initiation",
  () => {
    let envSnapshot: ReturnType<typeof captureEnv>;
    let root: string;
    let binDir: string;
    let workspace: string;
    let marker: string;

    beforeEach(async () => {
      envSnapshot = captureEnv([
        "HOME",
        "USERPROFILE",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "PATH",
        "SHELL",
      ]);
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-initiation-")));
      binDir = path.join(root, "bin");
      workspace = path.join(root, "workspace");
      marker = path.join(root, "native-effect");
      fs.mkdirSync(binDir);
      for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
        setTestEnvValue(name, root);
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
      setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin`);
      setTestEnvValue("SHELL", "/bin/sh");
      // The skill bin creates the marker file it is given, so any native launch leaves evidence.
      fs.copyFileSync("/usr/bin/touch", path.join(binDir, "skill-tool"));
      await writeSkill({
        dir: path.join(workspace, "skills", "skill-tool"),
        name: "skill-tool",
        description: "Runs the skill tool",
        metadata: '{"openclaw":{"requires":{"bins":["skill-tool"]}}}',
      });
      saveExecApprovals({
        version: 1,
        defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
        agents: { main: { autoAllowSkills: true, allowlist: [] } },
      });
      resetProcessRegistryForTests();
      registerEgress.mockClear();
      launchWait.during = undefined;
    });

    afterEach(() => {
      resetProcessRegistryForTests();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    // Mirrors the exec tool: gateway authorization, then the runtime launch with its hooks, with a
    // final-preflight denial unwrapped into the tool result. `borrowedPolicy` runs as agent
    // `execution` (which owns the skill) under the tool policy of agent `main`, whose workspace has
    // no skills, as tool assembly does when a run borrows another agent's policy.
    async function launchSkillCommand(borrowedPolicy = false) {
      const command = `skill-tool ${marker}`;
      const env = { PATH: `${binDir}:/usr/bin:/bin` };
      const approval = await processGatewayAllowlist({
        command,
        workdir: root,
        env,
        pty: false,
        defaultTimeoutSec: 30,
        security: "allowlist",
        ask: "off",
        safeBins: new Set(),
        safeBinProfiles: {},
        warnings: [],
        approvalRunningNoticeMs: 0,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        agentId: "main",
        ...(borrowedPolicy ? { skillScope: { ownerAgentId: "execution" } } : {}),
        config: {
          plugins: { enabled: false },
          agents: {
            entries: borrowedPolicy
              ? {
                  main: { workspace: path.join(root, "policy-workspace") },
                  execution: { workspace },
                }
              : { main: { workspace } },
          },
        } satisfies OpenClawConfig,
      });
      expect(approval.deniedResult).toBeUndefined();
      expect(approval.pendingResult).toBeUndefined();
      try {
        const run = await runExecProcess({
          command,
          execCommand: approval.execCommandOverride,
          workdir: root,
          env,
          secretEgressBindings: [],
          usePty: false,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          notifyOnExit: false,
          timeoutSec: 30,
          beforeSpawn: approval.revalidateBeforeExecution,
          assertCurrent: approval.assertCurrent,
          initiateSpawn: approval.initiateSpawn,
          releaseSpawn: approval.releaseSpawn,
        });
        return { outcome: await run.promise };
      } catch (error) {
        return { denied: ExecProcessPreflightError.unwrap(error) };
      }
    }

    it.each([false, true])(
      "launches the skill bin while skill trust holds through initiation (borrowed policy: %s)",
      async (borrowedPolicy) => {
        const result = await launchSkillCommand(borrowedPolicy);
        expect(result.outcome).toMatchObject({ status: "completed", exitCode: 0 });
        expect(registerEgress).toHaveBeenCalledOnce();
        expect(fs.existsSync(marker)).toBe(true);
      },
    );

    const uninstallSkill = () => {
      const skillDir = path.join(workspace, "skills", "skill-tool");
      fs.rmSync(skillDir, { recursive: true });
      bumpSkillsSnapshotVersion({
        workspaceDir: workspace,
        reason: "watch",
        changedPath: skillDir,
      });
    };

    // The spawn preflight has already re-resolved skill trust when these withdrawals land, so only a
    // synchronous recheck at native initiation can stop the launch.
    it.each([
      { name: "the authorizing skill is uninstalled", withdraw: uninstallSkill },
      {
        name: "the executing agent's skill is uninstalled under a borrowed policy",
        withdraw: uninstallSkill,
        borrowedPolicy: true,
      },
      {
        name: "the trusted bin name is repointed",
        withdraw: () => {
          const swapped = path.join(root, "swapped-tool");
          fs.copyFileSync("/usr/bin/touch", swapped);
          fs.rmSync(path.join(binDir, "skill-tool"));
          fs.symlinkSync(swapped, path.join(binDir, "skill-tool"));
        },
      },
    ])("denies at native initiation when $name after preflight", async (withdrawal) => {
      launchWait.during = withdrawal.withdraw;
      const result = await launchSkillCommand("borrowedPolicy" in withdrawal);
      // Preflight passed: the launch reached the post-preflight wait where trust was withdrawn.
      expect(registerEgress).toHaveBeenCalledOnce();
      expect(result.outcome).toBeUndefined();
      expect(result.denied?.details).toMatchObject({
        status: "failed",
        exitCode: null,
        aggregated: expect.stringContaining(
          "SYSTEM_RUN_DENIED: skill bin authorization changed before execution",
        ),
      });
      expect(fs.existsSync(marker)).toBe(false);
    });
  },
);
