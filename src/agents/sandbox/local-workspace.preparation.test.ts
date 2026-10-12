import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { projectionOperations } from "../../gateway/worker-environments/local-workspace-state.js";
import type { LocalWorkspaceOwner } from "../../gateway/worker-environments/local-workspace-types.js";
import type { DiagnosticPhaseSnapshot } from "../../infra/diagnostic-events.js";
import { withWorktreePreparationTiming } from "../worktrees/preparation-timing.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { prepareLocalSandboxWorkspace } from "./local-workspace.js";

type Projection = Pick<ReturnType<typeof projectionOperations>, "reuse" | "prepare">;
const fixture = vi.hoisted(() => {
  const owner: LocalWorkspaceOwner = {
    agentId: "main",
    sessionKey: "agent:main:fixture",
    sessionId: "fixture-session",
    lifecycleRevision: null,
    assertCurrent: () => {},
    worktree: {
      id: "fixture-worktree",
      name: "fixture",
      repoFingerprint: "fixture-repository",
      repoRoot: "/repository",
      path: "/managed/fixture",
      branch: "openclaw/fixture",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:fixture",
      createdAt: 1,
      lastActiveAt: 1,
    },
  };
  return {
    owner,
    reuse: vi.fn<Projection["reuse"]>(),
    prepare: vi.fn<Projection["prepare"]>(),
    allocate: vi.fn(() => {
      throw new Error("Unexpected allocation lease");
    }),
    event: vi.fn<(event: DiagnosticPhaseSnapshot) => void>(),
    log: vi.fn<(message: string, metadata: Record<string, unknown>) => void>(),
  };
});

// mock-isolation: Exercise preparation selection without opening the projection state database.
vi.mock("../../gateway/worker-environments/local-workspace-projection.js", () => ({
  resolveLocalWorkspaceOwner: () => fixture.owner,
  withLocalWorkspaceProjection: async <T>(
    _owner: LocalWorkspaceOwner,
    run: (state: Projection) => Promise<T>,
  ) => run({ reuse: fixture.reuse, prepare: fixture.prepare }),
}));
// mock-isolation: Neither covered flow should acquire allocation custody.
vi.mock("../worktrees/allocation.js", () => ({ withWorktreeAllocationLease: fixture.allocate }));
// mock-isolation: Retain the real timing owner while observing its output without global queues.
vi.mock("../../infra/diagnostic-events.js", () => ({
  createQueuedDiagnosticPhaseEmitter: () => fixture.event,
}));
// mock-isolation: Capture journal metadata without writing host logs.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: fixture.log }),
}));

afterEach(() => vi.clearAllMocks());

it.each([
  { name: "an existing projection", existing: "/projection/fixture", acceleration: true },
  { name: "disabled acceleration", existing: undefined, acceleration: false },
])("omits allocation timing for $name", async ({ existing, acceleration }) => {
  fixture.reuse.mockResolvedValue(existing);
  fixture.prepare.mockResolvedValue("/projection/fixture");
  const cfg: OpenClawConfig = { worktreeAcceleration: acceleration };
  const workspace = await withWorktreePreparationTiming("sandbox", () =>
    prepareLocalSandboxWorkspace({
      cfg,
      agentId: fixture.owner.agentId,
      sessionKey: fixture.owner.sessionKey,
      workspaceDir: "/managed/fixture/src",
      sandbox: resolveSandboxConfigForAgent(cfg, fixture.owner.agentId),
    }),
  );
  expect(workspace).toMatchObject({
    workspaceDir: "/projection/fixture",
    workspaceCwd: path.join("/projection/fixture", "src"),
  });
  expect(fixture.allocate).not.toHaveBeenCalled();
  expect(fixture.event).toHaveBeenCalledTimes(1);
  expect(fixture.event.mock.calls[0]?.[0].details).not.toHaveProperty("allocate");
  expect(fixture.log).toHaveBeenCalledTimes(1);
  expect(fixture.log.mock.calls[0]?.[1].phaseDurationsMs).not.toHaveProperty("allocate");
});
