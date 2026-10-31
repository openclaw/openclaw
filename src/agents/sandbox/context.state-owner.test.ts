import fs from "node:fs";
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
const builtinFactories = vi.hoisted(() => ({ docker: vi.fn(), podman: vi.fn() }));
vi.mock("./docker-backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-backend.js")>()),
  createDockerSandboxBackend: builtinFactories.docker,
  createPodmanSandboxBackend: builtinFactories.podman,
}));
vi.mock("./registry.js", () => registry);
vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.clearAllMocks());

it.each(["docker", "podman"] as const)(
  "does not await plugin runtime discovery for built-in %s setup",
  async (backend) => {
    const root = roots.make("sandbox-builtin-discovery-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      using _ = custody.acquireOwner(root);
      registry.readRegisteredSandboxRuntimeIds.mockImplementation(async () => {
        throw new Error("Built-in setup must not wait for plugin runtime discovery");
      });
      builtinFactories[backend].mockResolvedValueOnce({
        id: backend,
        runtimeId: "synthetic-builtin",
        runtimeLabel: "Synthetic built-in",
        workdir: "/workspace",
        buildExecSpec: vi.fn(),
        runShellCommand: vi.fn(),
      });
      try {
        const context = await custody.prepareContext(
          custody.createConfig({ backend }),
          "agent:main:subagent:builtin",
          path.join(root, "workspace"),
        );
        expect(context?.backendId).toBe(backend);
        expect(registry.readRegisteredSandboxRuntimeIds).not.toHaveBeenCalled();
      } finally {
        registry.readRegisteredSandboxRuntimeIds.mockReset();
      }
    });
  },
);

it("checks physical custody once per runtime assertion and refuses a successor owner", async () => {
  const root = roots.make("sandbox-owner-assertion-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const owner = custody.acquireOwner(root);
    let assertCurrent: (() => void) | undefined;
    const restore = registerSandboxBackend("owner-assertion", async (params) => {
      assertCurrent = params.assertRuntimeCurrent;
      return {
        id: "owner-assertion",
        runtimeId: "synthetic-owner-assertion",
        runtimeLabel: "Synthetic owner assertion",
        workdir: "/workspace",
        buildExecSpec: vi.fn(),
        runShellCommand: vi.fn(),
      };
    });
    let successor: ReturnType<typeof custody.acquireOwner> | undefined;
    try {
      registry.readRegisteredSandboxRuntimeIds.mockResolvedValueOnce([]);
      await custody.prepareContext(
        custody.createConfig({ backend: "owner-assertion" }),
        "agent:main:subagent:owner-assertion",
        path.join(root, "workspace"),
      );
      expect(assertCurrent).toBeDefined();
      const stat = vi.spyOn(fs, "lstatSync");
      try {
        assertCurrent!();
        // fs-safe brackets one physical custody verification with two leaf observations.
        expect(stat.mock.calls.filter(([pathname]) => pathname === owner.path)).toHaveLength(2);
      } finally {
        stat.mockRestore();
      }
      fs.unlinkSync(owner.path);
      expect(assertCurrent).toThrow();
      owner.release();
      successor = custody.acquireOwner(root);
      expect(assertCurrent).toThrow();
      expect(() => successor?.assertCurrent()).not.toThrow();
    } finally {
      successor?.release();
      owner.release();
      restore();
    }
  });
});

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
