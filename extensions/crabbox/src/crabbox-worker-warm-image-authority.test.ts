import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
} from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { observeWarmComparisonAdmission } from "./crabbox-worker-warm-image-admission.test-support.js";
import * as checkpoint from "./crabbox-worker-warm-image-checkpoint.js";
import {
  createSiblingFixture,
  currentAuthority,
  parsedProfile,
  warmAllocation,
  warmImage,
} from "./crabbox-worker-warm-image-sibling-admission.test-support.js";
import {
  openCrabboxWarmImageStore,
  type WarmAllocationRecord,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import { checkpointResult } from "./crabbox-worker-warm-image.test-support.js";

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

  it.each([
    "command return",
    "publication commit",
    "live publication",
    "after publication grant",
    "lost publication reply",
    "refused custody write",
    "successor selector",
  ] as const)("keeps capture custody separate from reusable admission: %s", async (boundary) => {
    const now = Date.now();
    const source = currentAuthority("capture source");
    const projectKey = "b".repeat(64);
    const captureKey = resolveCrabboxWarmImageProfileKey(parsedProfile, projectKey);
    const checkpointId = "chk_publication_returned";
    const preparation = {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "reserve" as const,
      demandAtMs: now,
    };
    const image = warmImage({
      checkpointId: "chk_publication_current",
      createdAtMs: now - 1_000,
      preparationKey: preparation.key,
      cacheKey: preparation.cacheKey,
      purpose: preparation.purpose,
      lastDemandAtMs: now,
      baseCommit: "e".repeat(40),
    });
    const previous = {
      ...image,
      checkpointId: "chk_publication_previous",
      createdAtMs: now - 2_000,
    };
    const sourceAllocation = warmAllocation({
      phase: "prepared",
      choice: { kind: "checkpoint", checkpointId: image.checkpointId },
      imageGeneration: { checkpointId: image.checkpointId, createdAtMs: image.createdAtMs },
      preparationKey: preparation.key,
      cacheKey: preparation.cacheKey,
      purpose: preparation.purpose,
      demandAtMs: now,
      baseCommit: image.baseCommit,
    });
    const before: WarmProfileRecord = {
      version: 3,
      projectKey,
      image,
      previous,
      allocations: {
        [leaseId]: sourceAllocation,
        currentBorrower: { ...sourceAllocation },
        previousBorrower: {
          ...sourceAllocation,
          choice: { kind: "checkpoint", checkpointId: previous.checkpointId },
          imageGeneration: {
            checkpointId: previous.checkpointId,
            createdAtMs: previous.createdAtMs,
          },
        },
      },
    };
    const deliveryFailure = new Error("synthetic publication reply lost after native commit");
    const custodyFailure = new Error("synthetic returned-checkpoint custody write refused");
    const delivered: WarmProfileRecord[] = [];
    const f = createSiblingFixture(
      undefined,
      async ({ namespace, key: changedKey, intent, result }) => {
        if (
          boundary !== "lost publication reply" ||
          delivered.length > 0 ||
          namespace !== "warm-images" ||
          changedKey !== captureKey ||
          intent.operation !== "update" ||
          intent.action !== "set" ||
          !isRecord(intent.value) ||
          !isRecord(intent.value.image) ||
          intent.value.image.checkpointId !== checkpointId
        ) {
          return;
        }
        expect(result.status).toBe("applied");
        const persisted = await f.store.lookup(captureKey);
        if (persisted?.image?.checkpointId !== checkpointId) {
          throw new Error("Publication reply fault requires the exact native committed image");
        }
        delivered.push(persisted);
        source.close();
        // Fail only delivery of the real comparison result; never replace the grant or DB.
        throw deliveryFailure;
      },
      { refreshAfterMs: 86_400_000, retainUnusedMs: 14 * 86_400_000, keepPrevious: 1 },
    );
    await f.store.register(captureKey, before);
    const claims: Array<Extract<WarmProfileRecord["operation"], { type: "capture" }>> = [];
    let replacement: WarmProfileRecord | undefined;
    // CLI effects are modeled. Worker, SQLite, comparison and final grants are real.
    const catalog = new Set([image.checkpointId, previous.checkpointId]);
    f.runCommand.mockImplementation(async (argv) => {
      if (argv[2] === "create") {
        expect(argv.slice(0, 3)).toEqual(["crabbox", "checkpoint", "create"]);
        expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
        expect(argv).toEqual(expect.arrayContaining(["--mode", "native", "--wait", "--json"]));
        const row = await f.store.lookup(captureKey);
        if (row?.operation?.type !== "capture" || row.operation.phase !== "creating") {
          throw new Error("Native create must own its exact durable creating claim");
        }
        claims.push(row.operation);
        if (boundary === "command return") {
          // Confirmed-stop custody is independent and cannot later be resurrected.
          await f.manager.release({ id: leaseId, binary: "crabbox", provider: "aws" });
        }
        if (boundary === "successor selector") {
          replacement = {
            ...row,
            operation: { ...row.operation, id: "successor-publication-selector" },
          };
          await f.store.register(captureKey, replacement);
        }
        catalog.add(checkpointId);
        return checkpointResult(checkpointId, leaseId, "completed");
      }
      if (argv[2] === "fork") {
        return commandResult({
          stdout: JSON.stringify({
            checkpointId: argv[3],
            leaseId: argv[argv.indexOf("--lease-id") + 1],
            slug: argv[argv.indexOf("--slug") + 1],
            provider: "aws",
            workdir: "/workspace",
          }),
        });
      }
      expect(argv).toEqual(["crabbox", "checkpoint", "delete", checkpointId]);
      expect(catalog.delete(checkpointId)).toBe(true);
      return commandResult({ stdout: "checkpoint deleted id=" + checkpointId + "\n" });
    });
    const parse = checkpoint.parseCreatedCheckpoint;
    const parsed = vi
      .spyOn(checkpoint, "parseCreatedCheckpoint")
      .mockImplementation((stdout, id) => {
        const created = parse(stdout, id);
        expect(created.checkpointId).toBe(checkpointId);
        // This existing parser runs AFTER checkpointCommand has actually returned,
        // unlike closing inside the command runner or before its successful result.
        if (
          boundary === "command return" ||
          boundary === "refused custody write" ||
          boundary === "successor selector"
        ) {
          source.close();
        }
        return created;
      });
    const gate = observeWarmComparisonAdmission({
      key: captureKey,
      matches: (row) =>
        boundary === "refused custody write"
          ? row.operation?.type === "retire" && row.operation.checkpointId === checkpointId
          : row.image?.checkpointId === checkpointId,
      beforeAdmit: (stage) => {
        if (stage === "commit" && boundary === "publication commit") {
          source.close();
        }
        if (stage === "commit" && boundary === "refused custody write") {
          throw custodyFailure;
        }
      },
      afterAdmit: (stage) => {
        if (stage === "commit" && boundary === "after publication grant") {
          source.close();
        }
      },
    });
    const scrub = vi.fn(async () => {});
    let result: { status: "fulfilled"; value: boolean } | { status: "rejected"; error: unknown };
    let parsedCalls: number;
    try {
      result = await f.manager
        .capture(
          {
            id: leaseId,
            binary: "crabbox",
            provider: "aws",
            profile: parsedProfile,
            forkedCheckpointId: image.checkpointId,
            projectCaptureRequired: true,
            signal: source.signal,
            assertCurrent: source.assertCurrent,
          },
          scrub,
        )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      parsedCalls = parsed.mock.calls.length;
    } finally {
      gate.restore();
      parsed.mockRestore();
    }
    const durable = await f.reopen(captureKey);
    expect(parsedCalls).toBe(1);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      leaseId,
      provider: "aws",
      phase: "creating",
      startedAtMs: expect.any(Number),
    });
    const capturedAtMs = claims[0]!.startedAtMs;
    expect(Number.isSafeInteger(capturedAtMs)).toBe(true);
    expect(scrub).toHaveBeenCalledOnce();
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
    expect(source.signal.aborted).toBe(false);
    if (boundary === "live publication") {
      expect(() => source.assertCurrent()).not.toThrow();
    } else {
      expect(() => source.assertCurrent()).toThrow(source.closed);
    }
    expect(catalog).toEqual(new Set([image.checkpointId, previous.checkpointId, checkpointId]));
    if (boundary === "live publication") {
      expect(result).toEqual({ status: "fulfilled", value: true });
    } else {
      expect(result).toEqual({ status: "rejected", error: source.closed });
      expect("error" in result ? result.error : undefined).toBe(source.closed);
    }
    const published =
      boundary === "live publication" ||
      boundary === "after publication grant" ||
      boundary === "lost publication reply";
    const allocations = { ...before.allocations };
    if (boundary === "command return") {
      delete allocations[leaseId];
    }
    if (published) {
      expect(durable).toEqual({
        ...before,
        image: { ...image, checkpointId, createdAtMs: capturedAtMs },
        previous: image,
        allocations: {
          ...allocations,
          [leaseId]: {
            ...sourceAllocation,
            imageGeneration: { checkpointId, createdAtMs: capturedAtMs },
          },
        },
        operation: { type: "retire", checkpointId: previous.checkpointId },
      });
      expect(gate.decisions).toEqual([
        { stage: "transaction", granted: true },
        { stage: "commit", granted: true },
      ]);
      if (boundary === "lost publication reply") {
        expect(delivered).toEqual([durable]);
      }
    } else if (boundary === "refused custody write") {
      // Failed custody persistence retains the original recovery selector. Never
      // invent non-submission or clear an already-created physical checkpoint.
      const retainedPhase =
        durable?.operation?.type === "capture" ? durable.operation.phase : undefined;
      expect(durable).toEqual({ ...before, operation: { ...claims[0], phase: retainedPhase } });
      // The failed debt CAS may leave its original creating bytes; an explicit
      // uncertainty write is also safe. Neither state permits a new capture.
      expect(retainedPhase).toMatch(/^(creating|uncertain)$/u);
      expect(f.managerWarn).toHaveBeenCalledWith(
        expect.stringContaining("--recover " + claims[0]!.id),
      );
      expect(f.managerWarn).toHaveBeenCalledWith(expect.stringContaining(checkpointId));
      expect(gate.decisions).toEqual([
        { stage: "transaction", granted: true },
        { stage: "commit", granted: false, error: custodyFailure },
      ]);
      return;
    } else if (boundary === "successor selector") {
      expect(durable).toEqual(replacement);
      expect(f.managerWarn).toHaveBeenCalledWith(expect.stringContaining(checkpointId));
      expect(f.managerWarn).toHaveBeenCalledWith(expect.stringContaining(claims[0]!.id));
      return;
    } else {
      // Closed sources preserve the prior generations. Only the returned
      // checkpoint becomes deletion debt, never a reusable successor.
      expect(durable).toEqual({
        ...before,
        allocations,
        operation: { type: "retire", checkpointId },
      });
      if (boundary === "publication commit") {
        expect(gate.decisions).toEqual([
          { stage: "transaction", granted: true },
          { stage: "commit", granted: false, error: source.closed },
        ]);
      } else {
        expect(
          gate.decisions.some((decision) => decision.stage === "commit" && decision.granted),
        ).toBe(false);
      }
    }
    const borrower = currentAuthority("later borrower");
    const selected = published ? checkpointId : image.checkpointId;
    await expect(
      f.manager.allocate({
        id: "cbx_publication_borrower",
        binary: "crabbox",
        provider: "aws",
        slug: "publication-borrower",
        profile: { ...parsedProfile, class: "standard", warmImage: true },
        projectKey,
        preparation,
        nodeRuntimeIdentity: sourceAllocation.runtimeIdentity,
        signal: borrower.signal,
        assertCurrent: borrower.assertCurrent,
        timeoutMs: () => 60_000,
      }),
    ).resolves.toEqual({ kind: "checkpoint", checkpointId: selected });
    expect(
      f.runCommand.mock.calls.filter(([argv]) => argv[2] === "fork").map(([argv]) => argv[3]),
    ).toEqual([selected]);
    expect((await f.reopen(captureKey))?.allocations.cbx_publication_borrower?.choice).toEqual({
      kind: "checkpoint",
      checkpointId: selected,
    });
    if (!published) {
      // Fresh independent cleanup deletes only the refused result, not either
      // preexisting generation or the already-released source allocation.
      await f.manager.maintain({ binaries: ["crabbox"] });
      expect((await f.reopen(captureKey))?.operation).toBeUndefined();
      expect(catalog).toEqual(new Set([image.checkpointId, previous.checkpointId]));
      if (boundary === "command return") {
        expect((await f.store.lookup(captureKey))?.allocations[leaseId]).toBeUndefined();
      }
    }
  });
});
