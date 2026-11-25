import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { projectionOperations } from "../../gateway/worker-environments/local-workspace-state.js";
import type { LocalWorkspaceOwner } from "../../gateway/worker-environments/local-workspace-types.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import * as allocation from "../worktrees/allocation.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "../worktrees/capacity-contract.js";
import {
  createWorktreeCapacityStatfs,
  useInProcessWorktreeCapacityTransport,
} from "../worktrees/capacity.test-support.js";
import { captureWorktreeRunEndContext } from "../worktrees/run-end-lifecycle.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { prepareLocalSandboxWorkspace } from "./local-workspace.js";
import { withSandboxRuntimePrune } from "./registry-lifecycle.js";
import { useSandboxRegistryState } from "./registry.test-support.js";

type Projection = Pick<ReturnType<typeof projectionOperations>, "reuse" | "prepare">;
const fixture = vi.hoisted(() => {
  const release = vi.fn();
  const owner: LocalWorkspaceOwner & Disposable = {
    agentId: "main",
    sessionKey: "agent:main:fixture",
    sessionId: "fixture-session",
    lifecycleRevision: null,
    assertCurrent: () => {},
    [Symbol.dispose]: release,
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
    release,
    reuse: vi.fn<Projection["reuse"]>(),
    prepare: vi.fn<Projection["prepare"]>(),
  };
});

// mock-isolation: Exercise preparation selection without opening the projection state database.
vi.mock("../../gateway/worker-environments/local-workspace-projection.js", () => ({
  resolveLocalWorkspaceOwner: () => fixture.owner,
  withLocalWorkspacePreparation: (
    _owner: LocalWorkspaceOwner,
    _options: unknown,
    prepare: (beginCapture: () => void) => Promise<string>,
  ) => prepare(() => {}),
  reuseLocalWorkspaceProjection: () => fixture.reuse(),
  withLocalWorkspaceProjection: async <T>(
    _owner: LocalWorkspaceOwner,
    run: (state: Projection) => Promise<T>,
  ) => run({ reuse: fixture.reuse, prepare: fixture.prepare }),
}));
// mock-isolation: This timing fixture supplies a synthetic projection without state storage.
vi.mock("../../gateway/worker-environments/local-workspace-checkout.js", () => ({
  localWorkspaceProjectionPath: () => "/projection/fixture",
}));
afterEach(() => vi.clearAllMocks());
const roots = useSandboxRegistryState("sandbox-preparation-prune-");

it("protects managed preparation and retained cleanup from pruning", async () => {
  const remove = vi.fn(async () => {});
  const prune = () =>
    withSandboxRuntimePrune(
      { sessionKey: "synthetic-scope", workspaceDir: "/projection/fixture" },
      remove,
    );
  fixture.reuse.mockImplementation(async () => {
    await prune();
    expect(remove).not.toHaveBeenCalled();
    return "/projection/fixture";
  });
  const workspace = await prepareLocalSandboxWorkspace({
    cfg: {},
    agentId: fixture.owner.agentId,
    sessionKey: fixture.owner.sessionKey,
    sandbox: resolveSandboxConfigForAgent({}, fixture.owner.agentId),
  });
  const release = workspace!.retain();
  await workspace!.protectRuntimeScope("synthetic-scope");
  workspace![Symbol.dispose]();
  try {
    await prune();
    await withSandboxRuntimePrune({ sessionKey: "synthetic-scope" }, remove);
    expect(remove).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await prune();
  expect(remove).toHaveBeenCalledOnce();
});

it.each([
  { name: "an existing projection", existing: "/projection/fixture", acceleration: true },
  { name: "disabled acceleration", existing: undefined, acceleration: false },
])("reuses the projection without allocation for $name", async ({ existing, acceleration }) => {
  const mutate = vi.spyOn(allocation, "withWorktreeMutationLease");
  fixture.reuse.mockResolvedValue(existing);
  fixture.prepare.mockResolvedValue("/projection/fixture");
  const cfg: OpenClawConfig = { worktreeAcceleration: acceleration };
  using workspace = await prepareLocalSandboxWorkspace({
    cfg,
    agentId: fixture.owner.agentId,
    sessionKey: fixture.owner.sessionKey,
    workspaceDir: "/managed/fixture/src",
    sandbox: resolveSandboxConfigForAgent(cfg, fixture.owner.agentId),
  });
  expect(workspace).toMatchObject({
    workspaceDir: "/projection/fixture",
    workspaceCwd: path.join("/projection/fixture", "src"),
  });
  expect(mutate).not.toHaveBeenCalled();
});

it.for([false, true])(
  "releases checkout custody for disk contention and rechecks caller authority (revoke=%s)",
  async (revoke, { signal }) => {
    useInProcessWorktreeCapacityTransport();
    const GiB = 1024 ** 3;
    vi.spyOn(fs, "statfsSync").mockReturnValue(
      createWorktreeCapacityStatfs(fs.statfsSync(roots.root), 6 * GiB),
    );
    const reserved = createDeferred();
    const release = createDeferred();
    const waiting = createDeferred();
    const wait = allocation.waitForWorktreeCapacity;
    vi.spyOn(allocation, "waitForWorktreeCapacity").mockImplementation((...args) => {
      waiting.resolve();
      return wait(...args);
    });
    fixture.reuse.mockResolvedValue(undefined);
    fixture.prepare.mockImplementation(async (dependencies) => {
      if (!dependencies?.allocation) {
        throw new Error("Cold projection requires disk admission");
      }
      await dependencies.allocation.requireDiskSpace(
        [{ path: roots.root, bytes: GiB }],
        "projection",
      );
      return "/projection/fixture";
    });
    let revoked = false;
    const holder = allocation.withWorktreeMutationLease(
      { env: process.env, id: "disk-holder", signal },
      async (guard) => {
        await guard.requireDiskSpace([{ path: roots.root, bytes: 3 * GiB }], "holder", true);
        reserved.resolve();
        await release.promise;
      },
    );
    let preparing: ReturnType<typeof prepareLocalSandboxWorkspace> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(reserved.promise, holder, "Disk reservation did not start"),
        signal,
      );
      preparing = prepareLocalSandboxWorkspace({
        cfg: {},
        agentId: fixture.owner.agentId,
        sessionKey: fixture.owner.sessionKey,
        sandbox: resolveSandboxConfigForAgent({}, fixture.owner.agentId),
        signal,
        assertCurrent: () => {
          if (revoked) {
            throw new Error("Caller authority revoked");
          }
        },
      });
      await withinTest(
        awaitGateBeforeSettlement(waiting.promise, preparing, "Disk contention did not wait"),
        signal,
      );
      await withOpenClawStateLeaseAsync(
        {
          scope: WORKTREE_MUTATION_LEASE_SCOPE,
          key: fixture.owner.worktree.id,
          leaseMs: 60_000,
          waitMs: 0,
        },
        captureWorktreeRunEndContext(process.env),
        async () => {},
      );
      revoked = revoke;
      release.resolve();
      if (revoke) {
        await expect(preparing).rejects.toThrow("Caller authority revoked");
        expect(fixture.prepare).toHaveBeenCalledTimes(1);
      } else {
        expect((await preparing)?.workspaceDir).toBe("/projection/fixture");
        expect(fixture.prepare).toHaveBeenCalledTimes(2);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([holder]);
      (await preparing?.catch(() => undefined))?.[Symbol.dispose]();
    }
  },
);
