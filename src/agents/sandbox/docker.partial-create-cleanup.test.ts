import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SandboxConfig } from "./types.js";

const containerMocks = vi.hoisted(() => ({ execContainer: vi.fn() }));
const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  execContainer: containerMocks.execContainer,
}));
vi.mock("./registry.js", () => registryMocks);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;

beforeAll(async () => {
  ({ ensureSandboxContainer } = await import("./docker.js"));
});

beforeEach(() => {
  registryMocks.readRegistryEntry.mockReset().mockResolvedValue(null);
  registryMocks.removeRegistryEntry.mockReset().mockResolvedValue(undefined);
  registryMocks.updateRegistry.mockReset().mockResolvedValue(undefined);
  containerMocks.execContainer.mockReset().mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "inspect") {
      return { code: 1, stdout: "", stderr: "No such object" };
    }
    if (args[0] === "exec") {
      throw new Error("setup failed");
    }
    return { code: 0, stdout: "", stderr: "" };
  });
});

function config(workspaceDir: string, setupCommand?: string): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess: "rw",
    workspaceRoot: path.join(os.homedir(), ".openclaw", "sandboxes"),
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      capDrop: ["ALL"],
      binds: [`${workspaceDir}:/workspace:rw`],
      dangerouslyAllowReservedContainerTargets: true,
      ...(setupCommand ? { setupCommand } : {}),
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

async function expectPartialRuntimeCleanup(params: {
  workspaceDir: string;
  cfg: SandboxConfig;
  expectedError: string;
}) {
  await expect(
    ensureSandboxContainer({
      scopeKey: "partial-create",
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.workspaceDir,
      cfg: params.cfg,
    }),
  ).rejects.toThrow(params.expectedError);
  expect(containerMocks.execContainer).toHaveBeenCalledWith(
    expect.anything(),
    ["rm", "-f", "oc-test-shared"],
    { allowFailure: true },
  );
  expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("oc-test-shared");
}

describe("fresh sandbox container cleanup", () => {
  it("removes a newly allocated runtime when setup fails before publication", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-partial-start-");
    await expectPartialRuntimeCleanup({
      workspaceDir,
      cfg: config(workspaceDir, "exit 1"),
      expectedError: "setup failed",
    });
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
  });

  it("removes the runtime when registry publication fails", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-registry-failure-");
    registryMocks.updateRegistry.mockRejectedValueOnce(new Error("registry publication failed"));
    await expectPartialRuntimeCleanup({
      workspaceDir,
      cfg: config(workspaceDir),
      expectedError: "registry publication failed",
    });
  });

  it("does not remove an existing runtime when allocation fails", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-name-conflict-");
    containerMocks.execContainer.mockImplementation(async (_engine, args: string[]) => {
      if (args[0] === "inspect") {
        return { code: 1, stdout: "", stderr: "inspection failed" };
      }
      if (args[0] === "create") {
        throw new Error("container name already in use");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(
      ensureSandboxContainer({
        scopeKey: "partial-create",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: config(workspaceDir),
      }),
    ).rejects.toThrow("container name already in use");

    expect(containerMocks.execContainer.mock.calls.some(([, args]) => args[0] === "rm")).toBe(
      false,
    );
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
  });

  it("surfaces a partial-runtime removal failure", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-partial-recovery-");
    containerMocks.execContainer.mockImplementation(async (_engine, args: string[]) => {
      if (args[0] === "inspect") {
        return { code: 1, stdout: "", stderr: "No such object" };
      }
      if (args[0] === "exec") {
        throw new Error("setup failed");
      }
      if (args[0] === "rm") {
        return { code: 1, stdout: "", stderr: "permission denied" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(
      ensureSandboxContainer({
        scopeKey: "partial-create",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: config(workspaceDir, "exit 1"),
      }),
    ).rejects.toThrow("creation and cleanup both failed");

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
  });
});
