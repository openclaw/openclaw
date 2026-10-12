import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { registerSandboxBackend } from "./backend.js";
import { resolveSandboxContext } from "./context.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

const registry = vi.hoisted(() => ({
  readRegisteredSandboxRuntimeIds: vi.fn<() => Promise<string[]>>(),
  updateRegistry: vi.fn(),
}));
vi.mock("./registry.js", () => registry);
vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));

const roots = useAutoCleanupTempDirTracker(afterEach);

it("rejects released hosted custody before ordinary sandbox backend provisioning", async () => {
  const root = roots.make("sandbox-owner-lifetime-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const owner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(root, "openclaw.json"),
        role: "gateway",
      },
    });
    const entered = createDeferred();
    const resume = createDeferred();
    registry.readRegisteredSandboxRuntimeIds.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return [];
    });
    const backend = vi.fn(async () => ({
      id: "owner-lifetime",
      runtimeId: "synthetic-owner-lifetime",
      runtimeLabel: "Synthetic owner lifetime",
      workdir: "/workspace",
      buildExecSpec: vi.fn(),
      runShellCommand: vi.fn(),
    }));
    const restore = registerSandboxBackend("owner-lifetime", backend);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          sandbox: {
            mode: "all",
            backend: "owner-lifetime",
            workspaceAccess: "rw",
            prune: { idleHours: 0, maxAgeDays: 0 },
          },
        },
      },
    };
    const sessionKey = "agent:main:subagent:owner-lifetime";
    const preparation = resolveSandboxContext({
      config,
      sessionKey,
      workspaceDir: path.join(root, "workspace"),
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
        "Preparation skipped registry lookup",
      );
      owner.release();
      resume.resolve();
      const result = await preparation.catch((error: unknown) => error);
      expect(backend).not.toHaveBeenCalled();
      expect(registry.updateRegistry).not.toHaveBeenCalled();
      expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
    } finally {
      resume.resolve();
      await preparation.catch(() => {});
      owner.release();
      restore();
    }
  });
});
