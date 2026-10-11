import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxContext } from "./context.js";
import type { prepareLocalSandboxWorkspace } from "./local-workspace.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";

const projection = vi.hoisted(() => ({
  prepare: vi.fn<typeof prepareLocalSandboxWorkspace>(),
}));
vi.mock("./local-workspace.js", () => ({
  prepareLocalSandboxWorkspace: projection.prepare,
}));

const roots = useAutoCleanupTempDirTracker(afterEach);

it("keeps managed workspace custody through awaited sandbox skill synchronization", async () => {
  const stateDir = roots.make("sandbox-managed-custody-");
  const workspaceDir = path.join(stateDir, "projection");
  await fs.mkdir(workspaceDir);
  const sessionKey = "agent:main:subagent:managed-custody";
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          workspaceAccess: "rw",
          workspaceRoot: path.join(stateDir, "sandboxes"),
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
    skills: { load: { watch: false } },
  };
  const { skillsWorkspaceDir } = resolveSandboxWorkspaceLayoutPaths({
    cfg: { ...resolveSandboxConfigForAgent(config, "main"), scope: "session" },
    rawSessionKey: sessionKey,
    agentId: "main",
    isolationSubject: { kind: "session", sessionKey },
    workspaceDir,
  });
  const targetSkills = path.join(skillsWorkspaceDir, "skills");
  await fs.mkdir(skillsWorkspaceDir, { recursive: true });
  await fs.writeFile(targetSkills, "preserve-managed-skills");
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, HOME: stateDir }, async () => {
      const owner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(),
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: path.join(stateDir, "openclaw.json"),
          role: "gateway",
        },
      });
      let revoked = false;
      const refusal = new Error("Local sandbox workspace authority changed");
      projection.prepare.mockImplementationOnce(async (params) => {
        const assertCurrent = () => {
          params.assertCurrent?.();
          if (revoked) {
            throw refusal;
          }
        };
        return {
          workspaceDir,
          workspaceCwd: workspaceDir,
          assertCurrent,
          provision: async <T>(run: () => Promise<T>) => {
            assertCurrent();
            const result = await run();
            assertCurrent();
            return result;
          },
          checkpoint: async () => {},
        };
      });
      const entered = createDeferred();
      const resume = createDeferred();
      const lstat = fs.lstat.bind(fs);
      const read = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (nodeFilePath(args[0]) === targetSkills) {
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
      const preparation = resolveSandboxContext({
        config,
        sessionKey,
        workspaceDir,
        preparedRuntimeStatus: resolveSandboxRuntimeStatus({
          cfg: config,
          sessionKey,
          preparedSessionEntry: null,
        }),
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          preparation,
          "Sandbox preparation skipped the managed skills read",
        );
        revoked = true;
        expect(() => owner.assertCurrent()).not.toThrow();
        resume.resolve();
        const result = await preparation.catch((error: unknown) => error);
        expect(await fs.readFile(targetSkills, "utf8")).toBe("preserve-managed-skills");
        expect(result).toMatchObject({ code: "sandbox_provisioning", cause: refusal });
      } finally {
        resume.resolve();
        await preparation.catch(() => {});
        read.mockRestore();
        owner.release();
      }
    });
  } finally {
    await fs.rm(skillsWorkspaceDir, { recursive: true, force: true });
  }
});
