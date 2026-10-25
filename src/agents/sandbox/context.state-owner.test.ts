import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { registerSandboxBackend } from "./backend.js";
import * as custody from "./context-custody.test-support.js";

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
    const owner = custody.acquireOwner(root);
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
    const config: OpenClawConfig = custody.createConfig(
      { backend: "owner-lifetime" },
      { agents: { defaults: { skipBootstrap: true } } },
    );
    const sessionKey = "agent:main:subagent:owner-lifetime";
    const preparation = custody.prepareContext(config, sessionKey, path.join(root, "workspace"));
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
