import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import { pause, warmRecord } from "./crabbox-warm-scenarios.test-support.js";
import { resolveCrabboxProvisionProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import {
  recoverCrabboxWarmImageCapture,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import {
  CHECKPOINT_ID,
  PROFILE,
  CLASSLESS_PROFILE,
  NODE_RUNTIME_IDENTITY,
  checkpointResult,
  jsonResult,
  tempDirs,
  unsupportedCaptureReceipt,
} from "./crabbox-worker-warm-image.test-support.js";

function fixture(
  failCreate = false,
  onCommand?: (argv: string[]) => ReturnType<typeof commandResult> | void,
  policy?: CrabboxWarmImagePolicy,
  prepareCapture: Parameters<
    typeof createCrabboxWarmImageManager
  >[0]["prepareCapture"] = async () => {},
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-allocation-"));
  const calls: string[][] = [];
  let captures = 0;
  const warn = vi.fn();
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (argv) => {
    calls.push(argv);
    const override = onCommand?.(argv);
    if (override) {
      return override;
    }
    if (failCreate && argv[2] === "create") {
      return commandResult({ code: null, killed: true, termination: "timeout" });
    }
    if (argv[2] === "create") {
      captures += 1;
      return checkpointResult(
        captures === 1 ? CHECKPOINT_ID : `${CHECKPOINT_ID}_${captures}`,
        argv[argv.indexOf("--id") + 1]!,
        "available",
      );
    }
    if (argv[2] === "inspect") {
      return jsonResult({
        localState: "metadata_available",
        providerState: "available",
        nextAction: "fork_or_delete",
      });
    }
    if (argv[2] === "fork") {
      return jsonResult({
        checkpointId: argv[3],
        leaseId: argv[argv.indexOf("--lease-id") + 1],
        slug: argv[argv.indexOf("--slug") + 1],
        provider: "aws",
        workdir: "/workspace",
      });
    }
    return commandResult();
  });
  const manager = () =>
    createCrabboxWarmImageManager({
      state: crabboxState,
      warn,
      policy,
      prepareCapture,
    });
  const context = (id: string, projectKey?: string) => ({
    binary: "crabbox",
    id,
    provider: "aws",
    slug: id,
    profile: resolveCrabboxProvisionProfile(PROFILE, undefined).profile,
    nodeRuntimeIdentity: NODE_RUNTIME_IDENTITY,
    ...(projectKey ? { projectKey } : {}),
    timeoutMs: () => 60_000,
  });
  const projectContext = (id: string, cacheKey = "b".repeat(64)) => ({
    ...context(id, "project-a"),
    preparation: {
      key: "a".repeat(64),
      cacheKey,
      purpose: "reserve" as const,
      demandAtMs: Date.now(),
    },
  });
  return { manager, owner: manager(), context, projectContext, calls, warn };
}

type Owner = ReturnType<ReturnType<typeof fixture>["manager"]>;
type Allocation = Parameters<Owner["allocate"]>[0];
const record = () => openWarmImageStore().entries()[0]?.value;
const snapshot = () => structuredClone(openWarmImageStore().entries());
const retainPrevious: CrabboxWarmImagePolicy = {
  refreshAfterMs: 86_400_000,
  retainUnusedMs: 14 * 86_400_000,
  keepPrevious: 1,
};
const checkpointChoice = { kind: "checkpoint", checkpointId: CHECKPOINT_ID };
const runtime = <T extends Allocation>(source: T, digest: string) => ({
  ...source,
  nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: digest.repeat(64) },
});

async function reopen(manager: () => Owner) {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  return manager();
}

async function prepare<T extends Allocation>(owner: Owner, source: T, commit: string) {
  await owner.allocate(source);
  await owner.markPrepared(source.id, commit);
  return source;
}

async function enroll<T extends Allocation>(owner: Owner, source: T) {
  await owner.allocate(source);
  await owner.markEnrolled(source.id);
  return source;
}

async function publish<T extends Allocation>(owner: Owner, source: T, commit?: string) {
  if (commit) {
    await prepare(owner, source, commit);
  } else {
    await enroll(owner, source);
  }
  await owner.capture(source);
  await owner.release(source);
  return source;
}

it("admits lifetime only for a claimed capture before preparing or scrubbing its source", async () => {
  const events: string[] = [];
  const prepareCapture = vi.fn(async () => {
    expect(record()?.operation).toMatchObject({
      type: "capture",
      leaseId: "cbx_lifetime",
      phase: "scrubbing",
    });
    events.push("lifetime");
  });
  const { owner, context } = fixture(false, undefined, undefined, prepareCapture);
  const source = await enroll(owner, context("cbx_lifetime"));
  await expect(
    owner.capture({ ...source, onCaptureStart: () => events.push("claimed") }, async () => {
      events.push("runtime-grant");
      return {
        timeoutMs: 30 * 60_000,
        run: async () => {
          events.push("prepare-and-scrub");
        },
      };
    }),
  ).resolves.toBe(true);
  expect(events).toEqual(["claimed", "runtime-grant", "lifetime", "prepare-and-scrub"]);
  expect(prepareCapture).toHaveBeenCalledWith(
    expect.objectContaining({ ...source, sourcePreparationTimeoutMs: 30 * 60_000 }),
  );
  await expect(owner.capture(source)).resolves.toBe(false);
  expect(prepareCapture).toHaveBeenCalledOnce();
});

it("skips optional capture visibly when lifetime cannot cover it and releases only its capture claim", async () => {
  const { owner, context, calls, warn } = fixture(false, undefined, undefined, async () => {
    throw new Error("lease_extension_budget_exceeded; existing deadline 2030-01-01T01:00:00Z");
  });
  const source = await enroll(owner, context("cbx_short_optional"));
  calls.length = 0;
  await expect(owner.capture({ ...source, teardown: true })).resolves.toBe(false);
  expect(calls).toEqual([]);
  const warning = "capture skipped: lease_extension_budget_exceeded; existing deadline";
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
  expect(record()?.operation).toBeUndefined();
  expect((await owner.lookupLease(source.id))?.phase).toBe("enrolled");
  await owner.release(source);
  expect(await owner.lookupLease(source.id)).toBeUndefined();
});

it.each(["runtime grant", "lifetime admission"])(
  "does not scrub a source recovered while %s was in flight",
  async (phase) => {
    const gate = pause();
    const prepareCapture = vi.fn(async () => {
      if (phase === "lifetime admission") {
        await gate.wait();
      }
    });
    const { owner, context, calls } = fixture(false, undefined, undefined, prepareCapture);
    const source = await enroll(owner, context("cbx_recovered_admission"));
    calls.length = 0;
    const run = vi.fn(async () => {});
    const capturing = owner.capture(source, async () => {
      if (phase === "runtime grant") {
        await gate.wait();
      }
      return { timeoutMs: 30 * 60_000, run };
    });
    await gate.entered;
    try {
      const operation = record()!.operation!;
      if (operation.type !== "capture") {
        throw new Error("Expected claimed capture");
      }
      await recoverCrabboxWarmImageCapture(crabboxState, operation.id, true);
    } finally {
      gate.release();
    }
    await expect(capturing).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(prepareCapture).toHaveBeenCalledTimes(phase === "runtime grant" ? 0 : 1);
    expect(record()?.operation).toBeUndefined();
  },
);

it.each([false, true])(
  "fails project preparation before source mutation when capture lifetime is denied (explicit requirement=%s)",
  async (required) => {
    const { owner, projectContext, calls } = fixture(false, undefined, undefined, async () => {
      throw new Error("lease_extension_unsupported_provider; size lifetime at creation");
    });
    const source = await prepare(owner, projectContext("cbx_short_project"), "a".repeat(40));
    calls.length = 0;
    const prepareAndScrub = vi.fn(async () => {});
    await expect(
      owner.capture(
        { ...source, ...(required ? { projectCaptureRequired: true as const } : {}) },
        async () => ({ timeoutMs: 30 * 60_000, run: prepareAndScrub }),
      ),
    ).rejects.toThrow(
      "Crabbox project image preparation failed: lease_extension_unsupported_provider",
    );
    expect(prepareAndScrub).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(record()?.operation).toBeUndefined();
    expect((await owner.lookupLease(source.id))?.phase).toBe("prepared");
  },
);

it("reports cold preparation before warmup and snapshot reuse before fork, retaining the latest cold reason", async () => {
  const { owner, manager, projectContext, calls } = fixture();
  const source = projectContext("cbx_status_source");
  const statuses: unknown[] = [];
  const reportStartStatus = (status: unknown) => {
    statuses.push(status);
    expect(calls.some((argv) => argv[1] === "warmup" || argv[2] === "fork")).toBe(false);
  };
  await owner.allocate({ ...source, prepareProject: true, reportStartStatus });
  expect(statuses).toEqual([{ mode: "cold", reason: "no-snapshot-yet", phase: "preparing" }]);
  await owner.markPrepared(source.id, "a".repeat(40));
  await owner.capture(source);
  calls.length = 0;
  statuses.length = 0;
  await owner.allocate({
    ...projectContext("cbx_status_fork"),
    prepareProject: true,
    reportStartStatus,
  });
  expect(statuses).toEqual([{ mode: "snapshot" }]);
  calls.length = 0;
  statuses.length = 0;
  const changed = projectContext("cbx_status_changed", "c".repeat(64));
  await owner.allocate({ ...changed, prepareProject: true, reportStartStatus });
  expect(statuses).toEqual([{ mode: "cold", reason: "setup-changed", phase: "preparing" }]);
  expect(record()?.latestColdReason).toBe("setup-changed");
  calls.length = 0;
  statuses.length = 0;
  await manager().allocate({ ...changed, prepareProject: true, reportStartStatus });
  expect(statuses).toEqual([{ mode: "cold", reason: "setup-changed", phase: "preparing" }]);
});

it.each([
  [{ ...PROFILE, warmImage: false }, "warm-images-off"],
  [{ ...CLASSLESS_PROFILE, target: "macos" }, "os-unsupported"],
  [CLASSLESS_PROFILE, "class-unknown"],
] as const)("reports a cold profile's actual limitation (%j)", async (profile, reason) => {
  const { owner, context } = fixture();
  const reportStartStatus = vi.fn();
  await owner.allocate({
    ...context("cbx_status_disabled"),
    profile: resolveCrabboxProvisionProfile(profile, undefined).profile,
    reportStartStatus,
  });
  expect(reportStartStatus).toHaveBeenCalledWith({ mode: "cold", reason, phase: "provisioning" });
});

it("leaves unrelated expired generations for maintenance during allocation", async () => {
  const { owner, context, calls } = fixture();
  await publish(owner, context("cbx_source"));
  const next = context("cbx_next");
  const store = openWarmImageStore();
  const image = store.entries()[0]!.value.image!;
  const expired = {
    ...image,
    checkpointId: "chk_unrelated",
    lastDemandAtMs: Date.now() - 14 * 86_400_000,
  };
  const unrelated = warmRecord({
    image: expired,
    previous: { ...expired, checkpointId: "chk_unrelated_previous" },
  });
  store.register("unrelated", unrelated);
  calls.length = 0;

  await owner.allocate(next);

  expect(calls.map((argv) => argv.slice(1, 3))).toEqual([["checkpoint", "fork"]]);
  expect(store.lookup("unrelated")).toEqual(unrelated);
  calls.length = 0;
  await owner.maintain({ binaries: ["crabbox"] });
  expect(calls.map((argv) => argv.slice(1))).toEqual([
    ["checkpoint", "delete", "chk_unrelated_previous"],
    ["checkpoint", "delete", "chk_unrelated"],
  ]);
  expect(store.lookup("unrelated")).toBeUndefined();
});

it.each([
  { providerState: "missing", retired: true },
  { providerState: "available", retired: false },
])(
  "after a failed fork, retires the image only when it is $providerState",
  async ({ providerState, retired }) => {
    let forkFails = false;
    const { owner, context, calls } = fixture(false, (argv) => {
      if (!forkFails) {
        return undefined;
      }
      if (argv[2] === "fork") {
        return commandResult({ code: 2, stderr: `checkpoint ${CHECKPOINT_ID} not found` });
      }
      return argv[2] === "inspect"
        ? commandResult({
            stdout: JSON.stringify({
              localState: "metadata_available",
              providerState,
              nextAction: providerState === "missing" ? "forget" : "fork_or_delete",
            }),
          })
        : undefined;
    });
    await publish(owner, context("cbx_source"));
    forkFails = true;

    const failed = context("cbx_failed");
    await expect(owner.allocate(failed)).rejects.toThrow("not found");
    expect(record()?.operation).toEqual(
      retired ? { type: "retire", checkpointId: CHECKPOINT_ID } : undefined,
    );

    if (!retired) {
      return;
    }
    calls.length = 0;
    expect(await owner.allocate(context("cbx_next"))).toEqual({ kind: "cold" });
    expect(calls.some((argv) => argv[2] === "fork")).toBe(false);
    // The failed lease still holds the checkpoint, so deletion waits for its release.
    expect(calls.some((argv) => argv[2] === "delete")).toBe(false);
    await owner.release(failed);
    expect(calls.some((argv) => argv[2] === "delete" && argv[3] === CHECKPOINT_ID)).toBe(true);
    expect(record()?.image).toBeUndefined();
  },
);

it("returns false and permits enrollment only after an unsupported capture receipt settles its claim", async () => {
  const { owner, context } = fixture(false, (argv) =>
    argv[2] === "create"
      ? commandResult({
          code: 2,
          stdout: JSON.stringify({
            ...unsupportedCaptureReceipt("cbx_project"),
            message: "x".repeat(1024),
          }),
        })
      : undefined,
  );
  const project = await prepare(owner, context("cbx_project", "project-a"), "a".repeat(40));
  await expect(owner.capture(project)).resolves.toBe(false);
  await owner.markEnrolled(project.id);
  expect((await owner.lookupLease(project.id))?.phase).toBe("enrolled");
  expect(record()?.operation).toBeUndefined();
});
it("starts incompatible preparation cold and retains its missing pinned predecessor", async () => {
  const { owner, projectContext, calls } = fixture(false, (argv) => {
    if (argv[2] === "inspect") {
      return jsonResult({
        localState: "metadata_available",
        providerState: "missing",
        nextAction: "delete_local",
      });
    }
    return undefined;
  });
  await publish(owner, projectContext("cbx_source"), "a".repeat(40));
  await owner.pin(CHECKPOINT_ID, true);
  const predecessor = structuredClone(record()!.image);
  const next = runtime(projectContext("cbx_next", "c".repeat(64)), "d");
  calls.length = 0;
  expect(await owner.allocate(next)).toEqual({ kind: "cold" });
  expect(calls.some((argv) => argv[1] === "warmup")).toBe(true);
  expect(calls.some((argv) => argv[2] === "fork")).toBe(false);
  await owner.markPrepared(next.id, "e".repeat(40));
  expect(await owner.capture(next)).toBe(true);
  expect(calls.some((argv) => argv[2] === "inspect" && argv[3] === CHECKPOINT_ID)).toBe(true);
  await owner.release(next);
  await owner.maintain({ binaries: ["crabbox"] });
  expect(record()).toMatchObject({
    image: {
      checkpointId: `${CHECKPOINT_ID}_2`,
      cacheKey: next.preparation.cacheKey,
      runtimeIdentity: next.nodeRuntimeIdentity,
    },
    previous: predecessor,
  });
  expect(calls.some((argv) => argv[2] === "delete")).toBe(false);
});

it("does not let an older cold admission overwrite a newly pinned generation", async () => {
  const { owner, projectContext, calls } = fixture(false, undefined, retainPrevious);
  await publish(owner, projectContext("cbx_source"), "a".repeat(40));
  await owner.pin(CHECKPOINT_ID, true);
  const older = projectContext("cbx_older", "c".repeat(64));
  const newer = projectContext("cbx_newer", "d".repeat(64));
  expect(await owner.allocate(older)).toEqual({ kind: "cold" });
  expect(await owner.allocate(newer)).toEqual({ kind: "cold" });
  await owner.markPrepared(older.id, "b".repeat(40));
  await owner.markPrepared(newer.id, "c".repeat(40));
  expect(await owner.capture(newer)).toBe(true);
  await owner.release(newer);
  await owner.pin(CHECKPOINT_ID, false);
  await owner.pin(`${CHECKPOINT_ID}_2`, true);
  const published = structuredClone(record()!.image);
  calls.length = 0;
  expect(await owner.capture(older)).toBe(false);
  expect(calls.some((argv) => argv[2] === "create")).toBe(false);
  expect(record()?.image).toEqual(published);
});

it("preserves two pinned generations and warns once instead of publishing a third", async () => {
  const { owner, projectContext, calls, warn } = fixture();
  await publish(owner, projectContext("cbx_source"), "a".repeat(40));
  await owner.pin(CHECKPOINT_ID, true);
  await publish(owner, projectContext("cbx_next", "c".repeat(64)), "b".repeat(40));
  await owner.pin(`${CHECKPOINT_ID}_2`, true);
  const third = await prepare(owner, projectContext("cbx_third", "d".repeat(64)), "c".repeat(40));
  const before = structuredClone(record());
  calls.length = 0;
  expect(await owner.capture(third)).toBe(false);
  expect(await owner.capture(third)).toBe(false);
  expect(calls.some((argv) => argv[2] === "create" || argv[2] === "delete")).toBe(false);
  expect(record()).toEqual(before);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/current and previous.*pinned/i));
});

it("keeps one predecessor and retires the older previous only after its borrower releases", async () => {
  const { owner, context, calls } = fixture(false, undefined, retainPrevious);
  await publish(owner, context("cbx_source"));
  const borrower = context("cbx_borrower");
  await owner.allocate(borrower);
  for (const [index, digest] of ["b", "c"].entries()) {
    const next = runtime(context(`cbx_next_${index}`), digest);
    await enroll(owner, next);
    expect(await owner.capture(next)).toBe(true);
    await owner.release(next);
    expect(record()?.previous?.checkpointId).toBe(
      index === 0 ? CHECKPOINT_ID : `${CHECKPOINT_ID}_2`,
    );
  }
  expect(openWarmImageStore().entries()).toHaveLength(1);
  expect(record()).toMatchObject({
    image: { checkpointId: `${CHECKPOINT_ID}_3` },
    operation: { type: "retire", checkpointId: CHECKPOINT_ID },
  });
  expect(calls.some((argv) => argv[2] === "delete")).toBe(false);
  await owner.release(borrower);
  const deleted = calls.filter((argv) => argv[2] === "delete").map((argv) => argv[3]);
  expect(deleted).toEqual([CHECKPOINT_ID]);
  expect(record()?.operation).toBeUndefined();
  expect(record()?.previous?.checkpointId).toBe(`${CHECKPOINT_ID}_2`);
});

it("preserves exact preparation replay and cache compatibility across reopen", async () => {
  const { owner, manager, projectContext, calls } = fixture();
  const source = await prepare(owner, projectContext("cbx_prepared"), "a".repeat(40));
  await owner.capture(source);
  const restarted = await reopen(manager);
  const recorded = snapshot();
  calls.length = 0;
  for (const changed of [
    { key: "c".repeat(64) },
    { cacheKey: "c".repeat(64) },
    { purpose: "session" as const },
    { demandAtMs: source.preparation.demandAtMs + 1 },
  ]) {
    await expect(
      restarted.allocate({ ...source, preparation: { ...source.preparation, ...changed } }),
    ).rejects.toThrow("recorded profile or project identity");
  }
  expect(calls).toEqual([]);
  expect(openWarmImageStore().entries()).toEqual(recorded);

  const compatible = {
    ...source,
    id: "cbx_compatible",
    preparation: { ...source.preparation, key: "c".repeat(64), purpose: "session" as const },
  };
  expect(await restarted.allocate(compatible)).toEqual(checkpointChoice);
  expect(
    await restarted.allocate({
      ...compatible,
      id: "cbx_incompatible",
      preparation: { ...compatible.preparation, cacheKey: "d".repeat(64) },
    }),
  ).toEqual({ kind: "cold" });
  const before = snapshot();
  await restarted.notePreparedDemand(compatible.id, {
    preparationKey: "e".repeat(64),
    demandAtMs: Date.now() + 60_000,
  });
  expect(openWarmImageStore().entries()).toEqual(before);
});

it("records Linux and replays historical allocations without os as Linux", async () => {
  const { owner, manager, context } = fixture();
  const allocation = context("cbx_historical_linux");
  await owner.allocate(allocation);
  expect(await owner.lookupLease(allocation.id)).toMatchObject({
    machineClass: "standard",
    os: "linux",
  });
  const store = openWarmImageStore();
  const entry = store.entries()[0]!;
  delete entry.value.allocations[allocation.id]!.os;
  store.register(entry.key, entry.value);
  await expect(manager().allocate(allocation)).resolves.toEqual({ kind: "cold" });
});

it("refreshes changed runtime content without letting an older cold allocation replace it", async () => {
  const { owner, context, calls } = fixture();
  const initial = context("cbx_initial");
  const older = context("cbx_older");
  await owner.allocate(initial);
  await owner.allocate(older);
  await owner.markEnrolled(initial.id);
  await owner.markEnrolled(older.id);
  await owner.capture(initial);
  await owner.release(initial);
  const newer = runtime(context("cbx_newer"), "b");
  expect(await owner.allocate(newer)).toEqual(checkpointChoice);
  await owner.markEnrolled(newer.id);
  expect(await owner.capture(newer)).toBe(true);
  await owner.release(newer);
  const published = structuredClone(record()!);
  expect(published.image?.runtimeIdentity).toEqual(newer.nodeRuntimeIdentity);
  expect(published.operation).toBeUndefined();
  calls.length = 0;
  expect(await owner.capture(older)).toBe(false);
  expect(calls).toEqual([]);
  expect(record()!.image).toEqual(published.image);
  await owner.release(older);
  expect(openWarmImageStore().entries()).toHaveLength(1);
});

it("preserves enrolled replay choices when runtime identity is missing or changes", async () => {
  const { owner, manager, context, calls } = fixture();
  const original = await enroll(owner, context("cbx_original"));
  const recorded = structuredClone(openWarmImageStore().entries()[0]!);
  const changed = runtime(original, "d");
  calls.length = 0;
  await expect(manager().allocate(changed)).rejects.toThrow("recorded node runtime identity");
  expect(calls).toEqual([]);
  expect(openWarmImageStore().entries()[0]).toEqual(recorded);
  delete recorded.value.allocations[original.id]!.runtimeIdentity;
  openWarmImageStore().register(recorded.key, recorded.value);
  const legacyRecorded = structuredClone(openWarmImageStore().entries()[0]!);
  const restarted = await reopen(manager);
  await expect(restarted.allocate(original)).rejects.toThrow("recorded node runtime identity");
  expect(await restarted.capture(original)).toBe(false);
  expect(calls).toEqual([]);
  expect(openWarmImageStore().entries()[0]).toEqual(legacyRecorded);
  await restarted.release(original);
  expect(openWarmImageStore().entries()).toEqual([]);
});

it("does not begin a native capture after project authority closes during scrub", async () => {
  let active = true;
  const { owner, context, calls } = fixture(false, (argv) => {
    if (argv[1] === "run") {
      active = false;
    }
  });
  const project = {
    ...context("cbx_project", "project-a"),
    assertCurrent: () => {
      if (!active) {
        throw new Error("project authority closed");
      }
    },
  };
  await prepare(owner, project, "a".repeat(40));
  await expect(owner.capture(project)).rejects.toThrow("project authority closed");
  expect(calls.some((argv) => argv[2] === "create")).toBe(false);
  expect(record()?.operation).toBeUndefined();
  expect((await owner.lookupLease(project.id))?.phase).toBe("prepared");
});

it("does not publish image demand when a fork completes after project expiry", async () => {
  const now = Date.now();
  const expiresAt = now + 60_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { owner, projectContext } = fixture(false, (argv) => {
    if (argv[2] === "fork") {
      clock.mockReturnValue(expiresAt);
    }
  });
  const source = await prepare(owner, projectContext("cbx_source"), "a".repeat(40));
  await owner.capture(source);
  const before = structuredClone(record()!.image);
  clock.mockReturnValue(now + 1_000);
  const next = projectContext("cbx_expired");
  const signal = new AbortController().signal;

  await expect
    .soft(
      owner.allocate({
        ...next,
        signal,
        assertCurrent: () => {
          if (Date.now() >= expiresAt) {
            throw new Error("project authority expired");
          }
        },
      }),
    )
    .rejects.toThrow();
  expect(signal.aborted).toBe(false);
  expect(record()!.image).toEqual(before);
  expect(await owner.lookupLease(next.id)).toMatchObject({
    phase: "pending",
    choice: checkpointChoice,
  });
});

it("keeps an uncertain project capture fenced before enrollment after restart", async () => {
  const { owner, manager, context, calls } = fixture(true);
  const project = await prepare(owner, context("cbx_project", "project-a"), "a".repeat(40));
  await expect(owner.capture(project)).rejects.toThrow("capture is unresolved");
  expect(record()?.operation).toMatchObject({
    type: "capture",
    leaseId: project.id,
    phase: "uncertain",
  });
  const restarted = await reopen(manager);
  calls.length = 0;
  await expect(restarted.capture(project)).rejects.toThrow("capture is unresolved");
  expect(calls).toEqual([]);
  await expect(restarted.markEnrolled(project.id)).rejects.toThrow("capture is unresolved");
  await restarted.release(project);
  expect(await restarted.lookupLease(project.id)).toBeUndefined();
  expect(record()?.operation?.type).toBe("capture");
});

it("refuses a full profile before allocation while allowing an existing cold replay", async () => {
  const { owner: initial, manager, context, calls } = fixture();
  await initial.allocate(context("cbx_existing"));
  const store = openWarmImageStore();
  const entry = store.entries()[0]!;
  const allocations: WarmProfileRecord["allocations"] = { ...entry.value.allocations };
  for (let index = 1; index < 256; index++) {
    allocations[`cbx_pending_${index}`] = { ...entry.value.allocations.cbx_existing! };
  }
  store.register(entry.key, { ...entry.value, allocations });
  const reopened = await reopen(manager);
  calls.length = 0;
  await expect(reopened.allocate(context("cbx_rejected"))).rejects.toThrow("capacity is full");
  expect(calls).toEqual([]);
  await reopened.allocate(context("cbx_existing"));
  expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
  await reopened.release(context("cbx_existing"));
  calls.length = 0;
  await reopened.allocate(context("cbx_rejected"));
  expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
  expect((await reopened.lookupLease("cbx_rejected"))?.choice).toEqual({ kind: "cold" });
});

it("captures newly completed setup only from the current image generation", async () => {
  const { owner, context, calls } = fixture();
  const source = await prepare(owner, context("cbx_source", "project-a"), "a".repeat(40));
  await owner.capture(source);
  const next = context("cbx_completed", "project-a");
  const stale = context("cbx_stale", "project-a");
  await owner.allocate(next);
  await owner.allocate(stale);
  await owner.markPrepared(next.id, "a".repeat(40));
  calls.length = 0;
  await owner.capture(next);
  expect(calls.some((argv) => argv[2] === "create")).toBe(false);
  await owner.capture({ ...next, projectCaptureRequired: true });
  expect(record()?.image?.checkpointId).toBe(`${CHECKPOINT_ID}_2`);
  const captures = calls.filter((argv) => argv[2] === "create").length;
  await owner.markPrepared(stale.id, "a".repeat(40));
  await owner.capture({ ...stale, projectCaptureRequired: true });
  expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(captures);
  expect(captures).toBe(1);
});
