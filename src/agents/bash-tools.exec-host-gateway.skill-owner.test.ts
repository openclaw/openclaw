import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { AnyAgentTool } from "./tools/common.js";

// No mocks: tool assembly, gateway authorization, the supervisor and the native launch are all
// real. Both bins are copies of `touch`, so a launch always leaves its marker file and a denial
// shows up as no marker.
describe.skipIf(process.platform === "win32")(
  "gateway skill trust under a borrowed tool policy",
  () => {
    let envSnapshot: ReturnType<typeof captureEnv>;
    let root: string;
    let binDir: string;

    beforeEach(async () => {
      envSnapshot = captureEnv([
        "HOME",
        "USERPROFILE",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "PATH",
        "SHELL",
      ]);
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-owner-")));
      binDir = path.join(root, "bin");
      fs.mkdirSync(binDir);
      for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
        setTestEnvValue(name, root);
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
      setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin`);
      setTestEnvValue("SHELL", "/bin/sh");
      // Each agent's workspace declares a different bin; only the executing agent's may be trusted.
      for (const [agent, bin] of [
        ["main", "policy-tool"],
        ["execution", "exec-tool"],
      ] as const) {
        fs.copyFileSync("/usr/bin/touch", path.join(binDir, bin));
        await writeSkill({
          dir: path.join(root, `workspace-${agent}`, "skills", bin),
          name: bin,
          description: `Runs ${bin}`,
          metadata: `{"openclaw":{"requires":{"bins":["${bin}"]}}}`,
        });
      }
      // Approval policy belongs to the policy agent `main`; `execution` has no approvals entry.
      saveExecApprovals({
        version: 1,
        defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
        agents: { main: { autoAllowSkills: true, allowlist: [] } },
      });
      setActivePluginRegistry(createEmptyPluginRegistry());
      resetProcessRegistryForTests();
    });

    afterEach(() => {
      resetProcessRegistryForTests();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    // Assembles exec as a run of agent `execution` that borrows agent `main`'s tool policy.
    function borrowedPolicyExecTool(): AnyAgentTool {
      const config = {
        plugins: { enabled: false },
        session: { scope: "global" },
        tools: { exec: { host: "gateway", security: "allowlist", ask: "off" } },
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: path.join(root, "workspace-main") },
            execution: { workspace: path.join(root, "workspace-execution") },
          },
        },
      } as OpenClawConfig;
      const tool = createOpenClawCodingTools({
        config,
        agentId: "execution",
        policyAgentId: "main",
        sessionKey: "global",
        runSessionKey: "agent:execution:main",
        workspaceDir: root,
        cwd: root,
        senderIsOwner: true,
        disableMessageTool: true,
        wrapBeforeToolCallHook: false,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: true,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      }).find((candidate) => candidate.name === "exec");
      if (!tool) {
        throw new Error("Expected exec in the assembled tools");
      }
      return tool;
    }

    async function runBin(bin: string) {
      const marker = path.join(root, `${bin}.marker`);
      const outcome = await borrowedPolicyExecTool()
        .execute(`call-${bin}`, { command: `${bin} ${marker}`, workdir: root })
        .then(
          (result) => ({ details: (result as { details?: unknown }).details }),
          (error: unknown) => ({ denied: String(error) }),
        );
      return { ...outcome, ran: fs.existsSync(marker) };
    }

    it("runs a bin declared by the executing agent's own skill", async () => {
      const result = await runBin("exec-tool");
      expect(result).toMatchObject({ details: { status: "completed", exitCode: 0 }, ran: true });
    });

    it("denies a bin declared only by the policy agent's skill, with no I/O", async () => {
      const result = await runBin("policy-tool");
      expect(result).toEqual({ denied: "Error: exec denied: allowlist miss", ran: false });
    });
  },
);
