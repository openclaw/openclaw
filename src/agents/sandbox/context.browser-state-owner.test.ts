import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { registerSandboxBackend } from "./backend.js";
import { SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH } from "./constants.js";
import * as custody from "./context-custody.test-support.js";
import { resolveSandboxContext } from "./context.js";
import { resolvePreparedSandboxRuntimeStatus } from "./runtime-status.js";

const docker = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  execDocker: vi.fn(),
  readDockerPort: vi.fn(),
}));
vi.mock("./docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker.js")>()),
  ...docker,
}));
// mock-isolation: custody tests keep registry publication separate from the acquired state owner.
vi.mock("./registry.js", () => ({
  readRegisteredSandboxRuntimeIds: async () => [],
  updateRegistry: vi.fn(),
  readBrowserRegistry: async () => ({ entries: [] }),
  updateBrowserRegistry: vi.fn(),
}));
// mock-isolation: browser selection fixtures have no skills to synchronize.
vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));

const roots = useAutoCleanupTempDirTracker(afterEach);

function createBrowserConfig(root: string) {
  return custody.createConfig(
    { browser: { enabled: true, network: "bridge" } },
    {
      gateway: { auth: { mode: "token", token: "synthetic-browser-token" } },
      agents: { defaults: { workspace: path.join(root, "workspace") } },
      tools: { sandbox: { tools: { allow: ["browser"] } } },
    },
  );
}

it.each([false, true])(
  "retains the workspace sandbox and requests the browser only when tools are enabled (disableTools=%s)",
  async (disableTools) => {
    const root = roots.make("sandbox-tool-free-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const owner = custody.acquireOwner(root);
      const runtimeId = "a".repeat(64);
      const createBackend = vi.fn(async () => ({
        id: "docker",
        runtimeId,
        runtimeLabel: "Synthetic workspace sandbox",
        workdir: "/workspace",
        capabilities: { browser: true },
        buildExecSpec: vi.fn(),
        runShellCommand: vi.fn(),
      }));
      const restore = registerSandboxBackend("docker", createBackend);
      docker.dockerContainerState
        .mockReset()
        .mockRejectedValue(new Error("Synthetic browser inspection reached"));
      const config = createBrowserConfig(root);
      const sessionKey = "agent:main:subagent:tool-free";
      try {
        const preparation = resolveSandboxContext({
          config,
          sessionKey,
          workspaceDir: path.join(root, "workspace"),
          disableTools,
          preparedRuntimeStatus: resolvePreparedSandboxRuntimeStatus({
            cfg: config,
            sessionKey,
            preparedSessionEntry: null,
          }),
        });
        if (disableTools) {
          const sandbox = await preparation;
          try {
            expect(sandbox).toMatchObject({ enabled: true, backendId: "docker", runtimeId });
            expect(sandbox?.browser).toBeUndefined();
            expect(docker.dockerContainerState).not.toHaveBeenCalled();
          } finally {
            sandbox?.[Symbol.dispose]?.();
          }
        } else {
          await expect(preparation).rejects.toThrow("Synthetic browser inspection reached");
          expect(docker.dockerContainerState).toHaveBeenCalledOnce();
        }
        expect(createBackend).toHaveBeenCalledOnce();
      } finally {
        owner.release();
        restore();
        for (const mock of Object.values(docker)) {
          mock.mockReset();
        }
      }
    });
  },
);

it("rejects hosted custody released during ordinary browser inspection before creation", async () => {
  const root = roots.make("sandbox-browser-owner-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const owner = custody.acquireOwner(root);
    const entered = createDeferred();
    const resume = createDeferred();
    docker.dockerContainerState.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { exists: false, running: false };
    });
    docker.execDocker.mockResolvedValue({
      code: 0,
      stdout: SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
      stderr: "",
    });
    // Stop before bridge launch if the missing guard lets allocation run.
    docker.readDockerPort.mockResolvedValue(null);
    const restore = registerSandboxBackend("docker", async () => ({
      id: "docker",
      runtimeId: "synthetic-browser-owner",
      runtimeLabel: "Synthetic browser owner",
      workdir: "/workspace",
      capabilities: { browser: true },
      buildExecSpec: vi.fn(),
      runShellCommand: vi.fn(),
    }));
    const config = createBrowserConfig(root);
    const sessionKey = "agent:main:subagent:browser-owner";
    const preparation = custody.prepareContext(config, sessionKey, path.join(root, "workspace"));
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        preparation,
        "Browser inspection not reached",
      );
      owner.release();
      resume.resolve();
      const error = await preparation.catch((failure: unknown) => failure);
      expect(
        docker.execDocker.mock.calls.filter(([args]) =>
          ["create", "start", "rm"].includes(args[0]),
        ),
      ).toEqual([]);
      expect(error).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
    } finally {
      resume.resolve();
      await preparation.catch(() => {});
      owner.release();
      restore();
    }
  });
});
