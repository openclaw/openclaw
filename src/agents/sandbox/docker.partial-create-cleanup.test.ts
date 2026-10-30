import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { DOCKER_SANDBOX_ENGINE, ensureSandboxContainer } from "./docker.js";

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
let workspaceDir: string;
const effects = () => containerMocks.execContainer.mock.calls.map(([, args]) => args[0]);

function mockEngine(effect: (stage: string) => void | Promise<void>) {
  containerMocks.execContainer.mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "inspect") {
      return { code: 1, stdout: "", stderr: "No such object" };
    }
    await effect(args[0]!);
    return { code: 0, stdout: "a".repeat(64), stderr: "" };
  });
}

beforeEach(() => {
  registryMocks.readRegistryEntry.mockReset().mockResolvedValue(null);
  registryMocks.removeRegistryEntry.mockReset().mockResolvedValue(undefined);
  registryMocks.updateRegistry.mockReset().mockResolvedValue(undefined);
  registryMocks.completeSandboxRegistryReservation.mockReset().mockResolvedValue(undefined);
  workspaceDir = tempDirs.make("openclaw-partial-create-");
  containerMocks.execContainer.mockReset();
  mockEngine((stage) => {
    if (stage === "exec") {
      throw new Error("setup failed");
    }
  });
});

function ensure(
  overrides: Partial<Parameters<typeof ensureSandboxContainer>[0]> = {},
  setupCommand?: string,
) {
  const defaults = resolveSandboxConfigForAgent();
  return ensureSandboxContainer({
    engine: DOCKER_SANDBOX_ENGINE,
    scopeKey: "partial-create",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: {
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
    },
    ...overrides,
  });
}

describe("fresh sandbox container cleanup", () => {
  it.each(["reservation", "create", "start"])(
    "fences effects after %s revocation",
    async (stage) => {
      let current = true;
      if (stage === "reservation") {
        registryMocks.updateRegistry.mockImplementationOnce(async () => {
          await Promise.resolve();
          current = false;
        });
      }
      mockEngine(async (effect) => {
        if (effect === stage) {
          await Promise.resolve();
          current = false;
        }
      });
      const assertCurrent = () => {
        if (!current) {
          throw new Error("runtime revoked");
        }
      };
      const pending = ensure(
        { scopeKey: "revoked", workspaceSource: "managed-worktree", assertCurrent },
        "echo should-not-run",
      );
      await expect(pending).rejects.toThrow("runtime revoked");
      const forbidden = new Set([
        "exec",
        ...(stage === "reservation" ? ["create", "start"] : stage === "create" ? ["start"] : []),
      ]);
      expect(effects().filter((effect) => forbidden.has(effect))).toEqual([]);
    },
  );

  it.each([
    ["create", "allocation response lost"],
    ["binding", "binding unavailable"],
  ])("preserves custody after %s failure", async (stage, error) => {
    if (stage === "binding") {
      registryMocks.updateRegistry.mockRejectedValueOnce(new Error(error));
    } else {
      mockEngine((effect) => {
        if (effect === "create") {
          expect(registryMocks.updateRegistry).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspaceDir }),
          );
          throw new Error(error);
        }
      });
    }
    await expect(
      ensure({ scopeKey: "managed-custody", workspaceSource: "managed-worktree" }),
    ).rejects.toThrow(error);
    expect(effects()).not.toContain(stage === "binding" ? "create" : "rm");
    if (stage === "create") {
      expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    }
  });

  it.each(["setup", "publication"])("cleans an allocated runtime after %s fails", async (stage) => {
    const setup = stage === "setup";
    const expectedError = setup ? "setup failed" : "registry publication failed";
    if (!setup) {
      registryMocks.updateRegistry.mockRejectedValueOnce(new Error(expectedError));
    }
    await expect(ensure({}, setup ? "exit 1" : undefined)).rejects.toThrow(expectedError);
    expect(containerMocks.execContainer).toHaveBeenCalledWith(
      expect.anything(),
      ["rm", "-f", "a".repeat(64)],
      { allowFailure: true },
    );
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("oc-test-shared", {
      preserveRemovalIntent: true,
    });
    if (setup) {
      expect(registryMocks.updateRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeState: "pending", workspaceDir }),
      );
      expect(registryMocks.completeSandboxRegistryReservation).not.toHaveBeenCalled();
    }
  });

  it("preserves readiness when inspection fails", async () => {
    registryMocks.readRegistryEntry.mockResolvedValue({
      runtimeState: "ready",
    });
    containerMocks.execContainer.mockResolvedValue({
      code: 125,
      stdout: "",
      stderr: "engine connection refused",
    });
    await expect(ensure({}, "echo setup")).rejects.toThrow("Unable to inspect Docker sandbox");
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
    expect(registryMocks.completeSandboxRegistryReservation).not.toHaveBeenCalled();
    expect(
      effects().filter((effect) => ["create", "start", "exec", "rm"].includes(effect)),
    ).toEqual([]);
  });
});
