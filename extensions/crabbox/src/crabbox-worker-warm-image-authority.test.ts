import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
} from "./crabbox-worker-profile.js";
import { observeWarmComparisonAdmission } from "./crabbox-worker-warm-image-admission.test-support.js";
import {
  openCrabboxWarmImageStore,
  type WarmAllocationRecord,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
});

const profile = parseCrabboxProfile({
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
  warmImage: true,
});
const key = resolveCrabboxWarmImageProfileKey(profile);
const leaseId = "cbx_authority_source";
const runtimeIdentity = {
  executionMode: "worker-turn" as const,
  nodeBootstrapSha256: "a".repeat(64),
};
const allocation: WarmAllocationRecord = {
  choice: { kind: "cold" },
  machineClass: "standard",
  os: "linux",
  phase: "pending",
  preparationKey: null,
  cacheKey: null,
  purpose: null,
  demandAtMs: null,
  imageGeneration: null,
  runtimeIdentity,
};

function openFixture() {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-warm-admission-"));
  return createPluginStateKeyedStoreForTests<WarmProfileRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });
}

function invocationAuthority() {
  const physical = new AbortController();
  const closed = new Error("synthetic invocation authority closed");
  let current = true;
  return {
    physical,
    closed,
    close: () => {
      current = false;
    },
    isCurrent: () => current,
    assertCurrent: vi.fn(() => {
      physical.signal.throwIfAborted();
      if (!current) {
        throw closed;
      }
    }),
  };
}

type Boundary = "transaction" | "commit" | "after commit grant";

function closeAtComparisonAdmission(boundary: Boundary, close: () => void) {
  return observeWarmComparisonAdmission({
    key,
    beforeAdmit: (stage) => {
      if (stage === boundary) {
        close();
      }
    },
    afterAdmit: (stage) => {
      if (stage === "commit" && boundary === "after commit grant") {
        close();
      }
    },
  });
}

const actions = ["record allocation", "mark prepared", "mark enrolled", "pin", "rollback"] as const;
const boundaries: Boundary[] = ["transaction", "commit", "after commit grant"];

describe("Crabbox warm-image final write authority", () => {
  it.each(actions.flatMap((action) => boundaries.map((boundary) => ({ action, boundary }))))(
    "$action honors invocation closure at $boundary with a live physical signal",
    async ({ action, boundary }) => {
      const fixture = openFixture();
      const image = {
        checkpointId: "chk_current",
        kind: "aws-ebs-snapshot",
        state: "available" as const,
        createdAtMs: 1,
        preparationKey: null,
        cacheKey: null,
        purpose: null,
        lastDemandAtMs: 1,
      };
      const previous = { ...image, checkpointId: "chk_previous", createdAtMs: 0 };
      const before: WarmProfileRecord = {
        version: 3,
        image,
        previous,
        allocations: {
          [leaseId]: { ...allocation, phase: action === "mark enrolled" ? "prepared" : "pending" },
          sibling: { ...allocation },
        },
      };
      await fixture.register(key, before);
      const authority = invocationAuthority();
      const runCommand = vi.fn<CrabboxCommandRunner>(async () => {
        throw new Error("A warm-state mutation must not dispatch a provider command");
      });
      const manager = createCrabboxWarmImageManager({
        state: crabboxState,
        runCommand,
        warn: vi.fn(),
        policy: { refreshAfterMs: 86_400_000, retainUnusedMs: 14 * 86_400_000, keepPrevious: 1 },
      });
      const warm = openCrabboxWarmImageStore(crabboxState);
      const baseCommit = "b".repeat(40);
      const invoke = {
        "record allocation": () =>
          warm.recordAllocation({
            key,
            id: "cbx_new",
            allocation,
            assertCurrent: authority.assertCurrent,
          }),
        "mark prepared": () => manager.markPrepared(leaseId, baseCommit, authority.assertCurrent),
        "mark enrolled": () => manager.markEnrolled(leaseId, authority.assertCurrent),
        pin: () => manager.pin(image.checkpointId, true, authority.assertCurrent),
        rollback: () => manager.rollback(previous.checkpointId, authority.assertCurrent),
      }[action];
      const gate = closeAtComparisonAdmission(boundary, authority.close);
      let outcome: { status: "fulfilled" } | { status: "rejected"; error: unknown };
      let stages: string[];
      let submitted: number;
      try {
        outcome = await invoke().then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        stages = [...gate.stages];
        submitted = gate.submissions().length;
      } finally {
        gate.restore();
      }
      expect(submitted).toBe(1);
      expect(authority.assertCurrent).toHaveBeenCalled();
      expect(authority.isCurrent()).toBe(false);
      expect(authority.physical.signal.aborted).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
      // Close and reopen the actual worker-backed database before checking durability.
      await closeOpenClawStateDatabaseAsync();
      const durable = await fixture.lookup(key);
      if (boundary !== "after commit grant") {
        expect
          .soft(stages)
          .toEqual(boundary === "transaction" ? ["transaction"] : ["transaction", "commit"]);
        expect.soft(outcome).toMatchObject({
          status: "rejected",
          error: { code: "PLUGIN_STATE_WRITE_FAILED" },
        });
        expect.soft(durable).toEqual(before);
        return;
      }
      expect(stages).toEqual(["transaction", "commit"]);
      expect(outcome).toEqual({ status: "fulfilled" });
      switch (action) {
        case "record allocation":
          expect(durable).toEqual({
            ...before,
            allocations: { ...before.allocations, cbx_new: allocation },
          });
          break;
        case "mark prepared":
        case "mark enrolled":
          expect(durable).toEqual({
            ...before,
            allocations: {
              ...before.allocations,
              [leaseId]: {
                ...before.allocations[leaseId],
                phase: action === "mark prepared" ? "prepared" : "enrolled",
                ...(action === "mark prepared" ? { baseCommit } : {}),
              },
            },
          });
          break;
        case "pin":
          expect(durable).toEqual({
            ...before,
            image: { ...image, pinned: { atMs: expect.any(Number) } },
          });
          break;
        case "rollback":
          expect(durable).toEqual({ ...before, image: previous, previous: image });
          break;
      }
    },
  );

  it("keeps confirmed-stop release independent of the last forward invocation", async () => {
    const fixture = openFixture();
    const before: WarmProfileRecord = {
      version: 3,
      allocations: { [leaseId]: { ...allocation }, sibling: { ...allocation } },
    };
    await fixture.register(key, before);
    const source = invocationAuthority();
    const cleanup = invocationAuthority();
    const manager = createCrabboxWarmImageManager({
      state: crabboxState,
      runCommand: async () => {
        throw new Error("Release must not create provider work");
      },
      warn: vi.fn(),
    });
    // Populate the manager's cached store through a forward invocation first.
    await manager.markEnrolled(leaseId, source.assertCurrent);
    source.close();
    await expect(
      manager.release({
        id: leaseId,
        binary: "crabbox",
        provider: "aws",
        signal: cleanup.physical.signal,
        assertCurrent: cleanup.assertCurrent,
      }),
    ).resolves.toBeUndefined();
    expect(source.physical.signal.aborted).toBe(false);
    expect(source.isCurrent()).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    expect(await fixture.lookup(key)).toEqual({
      version: 3,
      allocations: { sibling: before.allocations.sibling },
    });
  });

  it("records a returned capture after source closure without resurrecting its independently released lease", async () => {
    const fixture = openFixture();
    const demandAtMs = Date.now();
    await fixture.register(key, {
      version: 3,
      allocations: { [leaseId]: { ...allocation, phase: "enrolled", demandAtMs } },
    });
    const source = invocationAuthority();
    const cleanup = invocationAuthority();
    const warn = vi.fn();
    const commands: string[][] = [];
    const runCommand: CrabboxCommandRunner = async (argv) => {
      commands.push(argv);
      expect(argv.slice(1, 3)).toEqual(["checkpoint", "create"]);
      const owning = await fixture.lookup(key);
      expect(owning?.operation).toMatchObject({ type: "capture", phase: "creating", leaseId });
      source.close();
      await manager.release({
        id: leaseId,
        binary: "crabbox",
        provider: "aws",
        signal: cleanup.physical.signal,
        assertCurrent: cleanup.assertCurrent,
      });
      return {
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        stderr: "",
        stdout: JSON.stringify({
          id: "chk_returned_after_close",
          kind: "aws-ebs-snapshot",
          leaseId,
          native: { state: "completed" },
        }),
      };
    };
    const manager = createCrabboxWarmImageManager({ state: crabboxState, runCommand, warn });
    const scrub = vi.fn(async () => {});
    await expect(
      manager.capture(
        {
          id: leaseId,
          binary: "crabbox",
          provider: "aws",
          profile,
          signal: source.physical.signal,
          assertCurrent: source.assertCurrent,
        },
        scrub,
      ),
    ).rejects.toBe(source.closed);
    expect(scrub).toHaveBeenCalledOnce();
    expect(commands).toHaveLength(1);
    expect(source.physical.signal.aborted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await closeOpenClawStateDatabaseAsync();
    expect(await fixture.lookup(key)).toEqual({
      version: 3,
      allocations: {},
      image: {
        checkpointId: "chk_returned_after_close",
        kind: "aws-ebs-snapshot",
        state: "available",
        createdAtMs: expect.any(Number),
        preparationKey: null,
        cacheKey: null,
        purpose: null,
        lastDemandAtMs: demandAtMs,
        runtimeIdentity,
      },
    });
  });
});
