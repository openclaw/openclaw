import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer } from "./docker.js";
import type { SandboxConfig } from "./types.js";

const containerMocks = vi.hoisted(() => ({ execContainer: vi.fn() }));
const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
  completeSandboxRegistryReservation: vi.fn(),
}));

vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  execContainer: containerMocks.execContainer,
}));
vi.mock("./registry.js", () => registryMocks);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  registryMocks.readRegistryEntry.mockReset().mockResolvedValue(null);
  registryMocks.removeRegistryEntry.mockReset().mockResolvedValue(undefined);
  registryMocks.updateRegistry.mockReset().mockResolvedValue(undefined);
  registryMocks.completeSandboxRegistryReservation.mockReset().mockResolvedValue(undefined);
  containerMocks.execContainer.mockReset().mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "inspect") {
      return { code: 1, stdout: "", stderr: "No such object" };
    }
    if (args[0] === "exec") {
      throw new Error("setup failed");
    }
    return { code: 0, stdout: "a".repeat(64), stderr: "" };
  });
});

function config(workspaceDir: string, setupCommand?: string): SandboxConfig {
  const defaults = resolveSandboxConfigForAgent();
  return {
    ...defaults,
    mode: "all",
    scope: "shared",
    workspaceAccess: "rw",
    docker: {
      ...defaults.docker,
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      tmpfs: ["/tmp"],
      binds: [`${workspaceDir}:/workspace:rw`],
      dangerouslyAllowReservedContainerTargets: true,
      ...(setupCommand ? { setupCommand } : {}),
    },
  };
}

async function expectPartialRuntimeCleanup(params: {
  workspaceDir: string;
  cfg: SandboxConfig;
  expectedError: string;
}) {
  await expect(
    ensureSandboxContainer({
      ...containerParams(params.workspaceDir),
      cfg: params.cfg,
    }),
  ).rejects.toThrow(params.expectedError);
  expect(containerMocks.execContainer).toHaveBeenCalledWith(
    expect.anything(),
    ["rm", "-f", "a".repeat(64)],
    { allowFailure: true },
  );
  expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("oc-test-shared", {
    preserveRemovalIntent: true,
  });
}

function containerParams(workspaceDir: string, setupCommand?: string) {
  return {
    scopeKey: "partial-create",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: config(workspaceDir, setupCommand),
  };
}

describe("fresh sandbox container cleanup", () => {
  it.each(["image", "create", "start"])(
    "fences later runtime effects when authority closes after %s",
    async (stage) => {
      const workspaceDir = tempDirs.make("openclaw-runtime-revoked-");
      let current = true;
      containerMocks.execContainer.mockImplementation(async (_engine, args: string[]) => {
        if (args[0] === "inspect") {
          return { code: 1, stdout: "", stderr: "No such object" };
        }
        if (args[0] === stage) {
          await Promise.resolve();
          current = false;
        }
        return { code: 0, stdout: "a".repeat(64), stderr: "" };
      });
      await expect(
        ensureSandboxContainer({
          ...containerParams(workspaceDir, "echo should-not-run"),
          scopeKey: "revoked",
          workspaceSource: "managed-worktree",
          assertCurrent: () => {
            if (!current) {
              throw new Error("runtime revoked");
            }
          },
        }),
      ).rejects.toThrow("runtime revoked");
      const effects = containerMocks.execContainer.mock.calls.map(([, args]) => args[0]);
      expect(effects).not.toContain("exec");
      if (stage === "image") {
        expect(effects).not.toContain("create");
        expect(effects).not.toContain("start");
      }
      if (stage === "create") {
        expect(effects).not.toContain("start");
      }
    },
  );

  it.each([false, true])(
    "preserves unallocated custody after create failure (managed=%s)",
    async (managed) => {
      const workspaceDir = tempDirs.make("openclaw-create-failure-");
      const error = managed ? "allocation response lost" : "container name already in use";
      containerMocks.execContainer.mockImplementation(async (_engine, args: string[]) => {
        if (args[0] === "inspect") {
          return { code: 1, stdout: "", stderr: managed ? "No such object" : "inspection failed" };
        }
        if (args[0] === "create") {
          if (managed) {
            expect(registryMocks.updateRegistry).toHaveBeenLastCalledWith(
              expect.objectContaining({ workspaceDir }),
            );
          }
          throw new Error(error);
        }
        return { code: 0, stdout: "a".repeat(64), stderr: "" };
      });
      await expect(
        ensureSandboxContainer({
          ...containerParams(workspaceDir),
          ...(managed
            ? { scopeKey: "managed-custody", workspaceSource: "managed-worktree" as const }
            : {}),
        }),
      ).rejects.toThrow(error);
      expect(containerMocks.execContainer.mock.calls.some(([, args]) => args[0] === "rm")).toBe(
        false,
      );
      expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    },
  );

  it("never allocates a managed writer if its durable binding cannot be saved", async () => {
    const workspaceDir = tempDirs.make("openclaw-managed-binding-failure-");
    registryMocks.updateRegistry.mockRejectedValueOnce(new Error("binding unavailable"));
    await expect(
      ensureSandboxContainer({
        ...containerParams(workspaceDir),
        scopeKey: "managed-custody",
        workspaceSource: "managed-worktree",
      }),
    ).rejects.toThrow("binding unavailable");
    expect(containerMocks.execContainer.mock.calls.some(([, args]) => args[0] === "create")).toBe(
      false,
    );
  });

  it.each(["setup", "publication"])("cleans an allocated runtime after %s fails", async (stage) => {
    const workspaceDir = tempDirs.make("openclaw-docker-partial-start-");
    const setup = stage === "setup";
    const expectedError = setup ? "setup failed" : "registry publication failed";
    if (!setup) {
      registryMocks.updateRegistry.mockRejectedValueOnce(new Error(expectedError));
    }
    await expectPartialRuntimeCleanup({
      workspaceDir,
      cfg: config(workspaceDir, setup ? "exit 1" : undefined),
      expectedError,
    });
    if (setup) {
      expect(registryMocks.updateRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeState: "pending", workspaceDir }),
      );
      expect(registryMocks.completeSandboxRegistryReservation).not.toHaveBeenCalled();
    }
  });

  it("does not overwrite readiness when the existing runtime cannot be inspected", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-inspection-unavailable-");
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      backendId: "docker",
      sessionKey: "partial-create",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "openclaw-sandbox:test",
      runtimeState: "ready",
    });
    containerMocks.execContainer.mockResolvedValue({
      code: 125,
      stdout: "",
      stderr: "engine connection refused",
    });
    await expect(
      ensureSandboxContainer(containerParams(workspaceDir, "echo setup")),
    ).rejects.toThrow("Unable to inspect Docker sandbox");
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
    expect(registryMocks.completeSandboxRegistryReservation).not.toHaveBeenCalled();
    expect(
      containerMocks.execContainer.mock.calls.some(([, args]) =>
        ["create", "start", "exec", "rm"].includes(args[0]),
      ),
    ).toBe(false);
  });
});
