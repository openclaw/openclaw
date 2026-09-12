import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  parseCrabboxProfile,
  resolveCrabboxProvisionProfile,
  resolveCrabboxWarmImageProfileKey,
} from "./crabbox-worker-profile.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import {
  listCrabboxWarmImages,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import {
  CHECKPOINT_ID,
  PROFILE,
  NODE_RUNTIME_IDENTITY,
  checkpointResult,
  commandResult,
  createProjectOptions,
  createWarmProvider,
  openWarmImageStore,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

function fixture(
  failCreate = false,
  onCommand?: (argv: string[]) => ReturnType<typeof commandResult> | void,
  policy?: CrabboxWarmImagePolicy,
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-allocation-"));
  const calls: string[][] = [];
  let captures = 0;
  const warn = vi.fn();
  const manager = () =>
    createCrabboxWarmImageManager({
      warn,
      policy,
      runArgs: ({ id }) => ["run", "--id", id, "--script-stdin"],
      runCommand: async (argv) => {
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
          return commandResult({
            stdout: JSON.stringify({
              localState: "metadata_available",
              providerState: "available",
              nextAction: "fork_or_delete",
            }),
          });
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
        return commandResult();
      },
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
  return { manager, context, projectContext, calls, warn };
}

describe("Crabbox durable allocation admission", () => {
  it("forks an aged pinned checkpoint without refreshing until the operator unpins it", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const source = context("cbx_source");
    await owner.allocate(source);
    owner.markEnrolled(source.id);
    await owner.capture(source);
    await owner.release(source);
    const pinnedAtMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(pinnedAtMs);
    expect(owner.pin(CHECKPOINT_ID, true)).toMatchObject({ pinned: { atMs: pinnedAtMs } });
    clock.mockReturnValue(pinnedAtMs + 2 * 86_400_000);
    const next = context("cbx_next");
    expect(await owner.allocate(next)).toEqual({ kind: "checkpoint", checkpointId: CHECKPOINT_ID });
    owner.markEnrolled(next.id);
    calls.length = 0;
    expect(await owner.capture(next)).toBe(false);
    expect(calls.some((argv) => argv[2] === "create" || argv[2] === "delete")).toBe(false);
    expect(owner.pin(CHECKPOINT_ID, false).pinned).toBeUndefined();
    expect(await owner.capture(next)).toBe(true);
    expect(openWarmImageStore().entries()[0]?.value.image?.checkpointId).toBe(`${CHECKPOINT_ID}_2`);
    await owner.release(next);
    expect(calls.filter((argv) => argv[2] === "delete").map((argv) => argv[3])).toEqual([
      CHECKPOINT_ID,
    ]);
  });

  it("uses the configured refresh interval instead of the default age", async () => {
    const { manager, context, calls } = fixture(false, undefined, {
      refreshAfterMs: 3_600_000,
      retainUnusedMs: 14 * 86_400_000,
      keepPrevious: 0,
    });
    const owner = manager();
    const source = context("cbx_source");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await owner.allocate(source);
    owner.markEnrolled(source.id);
    await owner.capture(source);
    await owner.release(source);
    const next = context("cbx_next");
    await owner.allocate(next);
    owner.markEnrolled(next.id);
    calls.length = 0;
    clock.mockReturnValue(now + 3_600_000 - 1);
    expect(await owner.capture(next)).toBe(false);
    clock.mockReturnValue(now + 3_600_000);
    expect(await owner.capture(next)).toBe(true);
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
  });

  it.each(["available", "missing"] as const)(
    "starts an incompatible preparation cold and retains its %s pinned predecessor with keepPrevious disabled",
    async (providerState) => {
      const { manager, projectContext, calls } = fixture(false, (argv) => {
        if (argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "metadata_available",
              providerState,
              nextAction: providerState === "missing" ? "delete_local" : "fork_or_delete",
            }),
          });
        }
        return undefined;
      });
      const owner = manager();
      const source = projectContext("cbx_source");
      await owner.allocate(source);
      owner.markPrepared(source.id, "a".repeat(40));
      await owner.capture(source);
      await owner.release(source);
      owner.pin(CHECKPOINT_ID, true);
      const predecessor = structuredClone(openWarmImageStore().entries()[0]!.value.image);
      const next = {
        ...projectContext("cbx_next", "c".repeat(64)),
        nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: "d".repeat(64) },
      };
      calls.length = 0;
      expect(await owner.allocate(next)).toEqual({ kind: "cold" });
      expect(calls.some((argv) => argv[1] === "warmup")).toBe(true);
      expect(calls.some((argv) => argv[2] === "fork")).toBe(false);
      owner.markPrepared(next.id, "e".repeat(40));
      expect(await owner.capture(next)).toBe(true);
      expect(calls.some((argv) => argv[2] === "inspect" && argv[3] === CHECKPOINT_ID)).toBe(true);
      await owner.release(next);
      await owner.maintain({ binaries: ["crabbox"] });
      expect(openWarmImageStore().entries()[0]?.value).toMatchObject({
        image: {
          checkpointId: `${CHECKPOINT_ID}_2`,
          cacheKey: next.preparation.cacheKey,
          runtimeIdentity: next.nodeRuntimeIdentity,
        },
        previous: predecessor,
      });
      expect(calls.some((argv) => argv[2] === "delete")).toBe(false);
    },
  );

  it("does not let an older cold admission overwrite a newly pinned generation", async () => {
    const { manager, projectContext, calls } = fixture(false, undefined, {
      refreshAfterMs: 86_400_000,
      retainUnusedMs: 14 * 86_400_000,
      keepPrevious: 1,
    });
    const owner = manager();
    const source = projectContext("cbx_source");
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    await owner.release(source);
    owner.pin(CHECKPOINT_ID, true);
    const older = projectContext("cbx_older", "c".repeat(64));
    const newer = projectContext("cbx_newer", "d".repeat(64));
    expect(await owner.allocate(older)).toEqual({ kind: "cold" });
    expect(await owner.allocate(newer)).toEqual({ kind: "cold" });
    owner.markPrepared(older.id, "b".repeat(40));
    owner.markPrepared(newer.id, "c".repeat(40));
    expect(await owner.capture(newer)).toBe(true);
    await owner.release(newer);
    owner.pin(CHECKPOINT_ID, false);
    owner.pin(`${CHECKPOINT_ID}_2`, true);
    const published = structuredClone(openWarmImageStore().entries()[0]!.value.image);
    calls.length = 0;
    expect(await owner.capture(older)).toBe(false);
    expect(calls.some((argv) => argv[2] === "create")).toBe(false);
    expect(openWarmImageStore().entries()[0]?.value.image).toEqual(published);
  });

  it("preserves two pinned generations and warns once instead of publishing a third", async () => {
    const { manager, projectContext, calls, warn } = fixture();
    const owner = manager();
    const source = projectContext("cbx_source");
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    await owner.release(source);
    owner.pin(CHECKPOINT_ID, true);
    const next = projectContext("cbx_next", "c".repeat(64));
    await owner.allocate(next);
    owner.markPrepared(next.id, "b".repeat(40));
    await owner.capture(next);
    await owner.release(next);
    owner.pin(`${CHECKPOINT_ID}_2`, true);
    const third = projectContext("cbx_third", "d".repeat(64));
    await owner.allocate(third);
    owner.markPrepared(third.id, "c".repeat(40));
    const record = structuredClone(openWarmImageStore().entries()[0]!.value);
    calls.length = 0;
    expect(await owner.capture(third)).toBe(false);
    expect(await owner.capture(third)).toBe(false);
    expect(calls.some((argv) => argv[2] === "create" || argv[2] === "delete")).toBe(false);
    expect(openWarmImageStore().entries()[0]?.value).toEqual(record);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/current and previous.*pinned/i));
  });

  it("keeps one predecessor and retires the older previous only after its borrower releases", async () => {
    const { manager, context, calls } = fixture(false, undefined, {
      refreshAfterMs: 86_400_000,
      retainUnusedMs: 14 * 86_400_000,
      keepPrevious: 1,
    });
    const owner = manager();
    const source = context("cbx_source");
    await owner.allocate(source);
    owner.markEnrolled(source.id);
    await owner.capture(source);
    await owner.release(source);
    const borrower = context("cbx_borrower");
    await owner.allocate(borrower);
    for (const [index, digest] of ["b", "c"].entries()) {
      const next = {
        ...context(`cbx_next_${index}`),
        nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: digest.repeat(64) },
      };
      await owner.allocate(next);
      owner.markEnrolled(next.id);
      expect(await owner.capture(next)).toBe(true);
      await owner.release(next);
      expect(openWarmImageStore().entries()[0]?.value.previous?.checkpointId).toBe(
        index === 0 ? CHECKPOINT_ID : `${CHECKPOINT_ID}_2`,
      );
    }
    expect(openWarmImageStore().entries()).toHaveLength(1);
    expect(openWarmImageStore().entries()[0]?.value).toMatchObject({
      image: { checkpointId: `${CHECKPOINT_ID}_3` },
      operation: { type: "retire", checkpointId: CHECKPOINT_ID },
    });
    expect(calls.some((argv) => argv[2] === "delete")).toBe(false);
    await owner.release(borrower);
    expect(calls.filter((argv) => argv[2] === "delete").map((argv) => argv[3])).toEqual([
      CHECKPOINT_ID,
    ]);
    expect(openWarmImageStore().entries()[0]?.value.operation).toBeUndefined();
    expect(openWarmImageStore().entries()[0]?.value.previous?.checkpointId).toBe(
      `${CHECKPOINT_ID}_2`,
    );
  });

  it("carries configured profile and project display facts through provisioning to inspection", async () => {
    const { options, observe } = createProjectOptions([]);
    const { provider } = createWarmProvider(observe);
    await provider.provision(PROFILE, "display-facts", {
      ...options,
      profileId: "linux-development",
      project: {
        ...options.project,
        label: "github.com/example/project",
        root: "/projects/example",
      },
    });
    expect(listCrabboxWarmImages()).toEqual([
      expect.objectContaining({
        profileId: "linux-development",
        backend: "aws",
        machineClass: "standard",
        os: "linux",
        projectLabel: "github.com/example/project",
        projectRoot: "/projects/example",
        checkpointId: CHECKPOINT_ID,
      }),
    ]);
  });

  it("updates last-allocator display facts without changing shared keys or replay choices", async () => {
    const { manager, context } = fixture();
    const owner = manager();
    const source = { ...context("cbx_first", "project-a"), profileId: "first" };
    await owner.allocate(source);
    const original = structuredClone(openWarmImageStore().entries()[0]!);
    const next = {
      ...source,
      id: "cbx_second",
      profileId: "second",
      projectLabel: "github.com/example/renamed",
      projectRoot: "/projects/renamed",
    };
    await owner.allocate(next);
    expect(openWarmImageStore().entries()).toHaveLength(1);
    expect(listCrabboxWarmImages()[0]).toMatchObject({
      profileKey: original.key,
      profileId: "second",
      projectLabel: next.projectLabel,
      projectRoot: next.projectRoot,
    });
    await owner.allocate(source);
    const replayed = listCrabboxWarmImages()[0]!;
    expect(replayed.profileId).toBe("first");
    expect(replayed.projectLabel).toBeUndefined();
    expect(replayed.projectRoot).toBeUndefined();
    expect(replayed.allocations[source.id]).toEqual(original.value.allocations[source.id]);
    await owner.allocate({ ...source, profileId: undefined });
    expect(listCrabboxWarmImages()[0]?.profileId).toBeUndefined();
  });

  it("preserves exact preparation replay and cache compatibility across reopen", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const source = {
      ...context("cbx_prepared", "project-a"),
      preparation: {
        key: "a".repeat(64),
        cacheKey: "b".repeat(64),
        purpose: "reserve" as const,
        demandAtMs: Date.now(),
      },
    };
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    resetPluginStateStoreForTests();
    const restarted = manager();
    const recorded = structuredClone(openWarmImageStore().entries());
    calls.length = 0;
    for (const changed of [
      { key: "c".repeat(64) },
      { cacheKey: "c".repeat(64) },
      { purpose: "session" as const },
      { demandAtMs: source.preparation.demandAtMs + 1 },
    ]) {
      await expect(
        restarted.allocate({
          ...source,
          preparation: { ...source.preparation, ...changed },
        }),
      ).rejects.toThrow("recorded profile or project identity");
    }
    expect(calls).toEqual([]);
    expect(openWarmImageStore().entries()).toEqual(recorded);

    const compatible = {
      ...source,
      id: "cbx_compatible",
      preparation: { ...source.preparation, key: "c".repeat(64), purpose: "session" as const },
    };
    expect(await restarted.allocate(compatible)).toEqual({
      kind: "checkpoint",
      checkpointId: CHECKPOINT_ID,
    });
    expect(
      await restarted.allocate({
        ...compatible,
        id: "cbx_incompatible",
        preparation: { ...compatible.preparation, cacheKey: "d".repeat(64) },
      }),
    ).toEqual({ kind: "cold" });
    const before = structuredClone(openWarmImageStore().entries());
    restarted.notePreparedDemand(compatible.id, {
      preparationKey: "e".repeat(64),
      demandAtMs: Date.now() + 60_000,
    });
    expect(openWarmImageStore().entries()).toEqual(before);
  });

  it("does not keep an image alive through refill after actual demand expires", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const demandAtMs = Date.now();
    const source = {
      ...context("cbx_source", "project-a"),
      preparation: {
        key: "a".repeat(64),
        cacheKey: "b".repeat(64),
        purpose: "reserve" as const,
        demandAtMs,
      },
    };
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    await owner.release(source);
    const clock = vi.spyOn(Date, "now").mockReturnValue(demandAtMs + 13 * 86_400_000);
    const reserve = { ...source, id: "cbx_refill" };
    expect(await owner.allocate(reserve)).toEqual({
      kind: "checkpoint",
      checkpointId: CHECKPOINT_ID,
    });
    expect(openWarmImageStore().entries()[0]!.value.image?.lastDemandAtMs).toBe(demandAtMs);
    await owner.release(reserve);
    clock.mockReturnValue(demandAtMs + 14 * 86_400_000);
    calls.length = 0;
    await owner.maintain({ binaries: ["crabbox"] });
    expect(calls.filter((argv) => argv[2] === "delete").map((argv) => argv[3])).toEqual([
      CHECKPOINT_ID,
    ]);
    expect(openWarmImageStore().entries()).toEqual([]);
  });

  it("preserves persisted Linux profile keys", () => {
    const linux = parseCrabboxProfile(PROFILE);
    const historicalKey = "e35cd88dba7a4bea90d23da00f994d326515a833ab64fdaa982c5c346bfc9e0f";
    expect(resolveCrabboxWarmImageProfileKey(linux)).toBe(historicalKey);
  });

  it("records Linux and replays historical allocations without os as Linux", async () => {
    const { manager, context } = fixture();
    const owner = manager();
    const allocation = context("cbx_historical_linux");
    await owner.allocate(allocation);
    expect(owner.lookupLease(allocation.id)).toMatchObject({
      machineClass: "standard",
      os: "linux",
    });
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    delete entry.value.allocations[allocation.id]!.os;
    store.register(entry.key, entry.value);
    await expect(manager().allocate(allocation)).resolves.toEqual({ kind: "cold" });
  });

  it.each([
    { nodeBootstrapSha256: "b".repeat(64) },
    { executionMode: "remote-exec" as const },
    { workerBundleSha256: "c".repeat(64) },
  ])(
    "refreshes changed runtime content without letting an older cold allocation replace it: %j",
    async (change) => {
      const { manager, context, calls } = fixture();
      const owner = manager();
      const initial = context("cbx_initial");
      const older = context("cbx_older");
      await owner.allocate(initial);
      await owner.allocate(older);
      owner.markEnrolled(initial.id);
      owner.markEnrolled(older.id);
      await owner.capture(initial);
      await owner.release(initial);
      const newer = {
        ...context("cbx_newer"),
        nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, ...change },
      };
      expect(await owner.allocate(newer)).toEqual({
        kind: "checkpoint",
        checkpointId: CHECKPOINT_ID,
      });
      owner.markEnrolled(newer.id);
      expect(await owner.capture(newer)).toBe(true);
      await owner.release(newer);
      const published = structuredClone(openWarmImageStore().entries()[0]!.value);
      expect(published.image?.runtimeIdentity).toEqual(newer.nodeRuntimeIdentity);
      expect(published.operation).toBeUndefined();
      calls.length = 0;
      expect(await owner.capture(older)).toBe(false);
      expect(calls).toEqual([]);
      expect(openWarmImageStore().entries()[0]!.value.image).toEqual(published.image);
      await owner.release(older);
      expect(openWarmImageStore().entries()).toHaveLength(1);
    },
  );

  it.each(["pending", "enrolled"] as const)(
    "preserves %s replay choices when runtime identity is missing or changes",
    async (phase) => {
      const { manager, context, calls } = fixture();
      const owner = manager();
      const original = context("cbx_original");
      await owner.allocate(original);
      if (phase === "enrolled") {
        owner.markEnrolled(original.id);
      }
      const recorded = structuredClone(openWarmImageStore().entries()[0]!);
      const changed = {
        ...original,
        nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: "d".repeat(64) },
      };
      calls.length = 0;
      await expect(manager().allocate(changed)).rejects.toThrow("recorded node runtime identity");
      expect(calls).toEqual([]);
      expect(openWarmImageStore().entries()[0]).toEqual(recorded);
      delete recorded.value.allocations[original.id]!.runtimeIdentity;
      openWarmImageStore().register(recorded.key, recorded.value);
      const legacyRecorded = structuredClone(openWarmImageStore().entries()[0]!);
      resetPluginStateStoreForTests();
      const restarted = manager();
      await expect(restarted.allocate(original)).rejects.toThrow("recorded node runtime identity");
      expect(await restarted.capture(original)).toBe(false);
      expect(calls).toEqual([]);
      expect(openWarmImageStore().entries()[0]).toEqual(legacyRecorded);
      await restarted.release(original);
      expect(openWarmImageStore().entries()).toEqual([]);
    },
  );

  it("uses an image without runtime metadata as a base but refreshes its unproven content", async () => {
    const { manager, context } = fixture();
    const owner = manager();
    const original = context("cbx_original");
    await owner.allocate(original);
    owner.markEnrolled(original.id);
    await owner.capture(original);
    await owner.release(original);
    const legacy = openWarmImageStore().entries()[0]!;
    delete legacy.value.image!.runtimeIdentity;
    openWarmImageStore().register(legacy.key, legacy.value);
    const next = context("cbx_next");
    expect(await owner.allocate(next)).toEqual({ kind: "checkpoint", checkpointId: CHECKPOINT_ID });
    owner.markEnrolled(next.id);
    expect(await owner.capture(next)).toBe(true);
    expect(openWarmImageStore().entries()[0]!.value.image?.runtimeIdentity).toEqual(
      NODE_RUNTIME_IDENTITY,
    );
    await owner.release(next);
    expect(openWarmImageStore().entries()).toHaveLength(1);
  });

  it("does not begin a native capture after project authority closes during scrub", async () => {
    let active = true;
    const { manager, context, calls } = fixture(false, (argv) => {
      if (argv[1] === "run") {
        active = false;
      }
    });
    const owner = manager();
    const project = {
      ...context("cbx_project", "project-a"),
      assertCurrent: () => {
        if (!active) {
          throw new Error("project authority closed");
        }
      },
    };
    await owner.allocate(project);
    owner.markPrepared(project.id, "a".repeat(40));
    await expect(owner.capture(project)).rejects.toThrow("project authority closed");
    expect(calls.some((argv) => argv[2] === "create")).toBe(false);
    expect(openWarmImageStore().entries()[0]?.value.operation).toBeUndefined();
    expect(owner.lookupLease(project.id)?.phase).toBe("prepared");
  });

  it("does not publish image demand when a fork completes after project expiry", async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { manager, projectContext } = fixture(false, (argv) => {
      if (argv[2] === "fork") {
        clock.mockReturnValue(expiresAt);
      }
    });
    const owner = manager();
    const source = projectContext("cbx_source");
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    const before = structuredClone(openWarmImageStore().entries()[0]!.value.image);
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
    expect(openWarmImageStore().entries()[0]!.value.image).toEqual(before);
    expect(owner.lookupLease(next.id)).toMatchObject({
      phase: "pending",
      choice: { kind: "checkpoint", checkpointId: CHECKPOINT_ID },
    });
  });

  it("keeps an uncertain project capture fenced before enrollment after restart", async () => {
    const { manager, context, calls } = fixture(true);
    const owner = manager();
    const project = context("cbx_project", "project-a");
    await owner.allocate(project);
    owner.markPrepared(project.id, "a".repeat(40));
    await expect(owner.capture(project)).rejects.toThrow("capture is unresolved");
    expect(openWarmImageStore().entries()[0]?.value.operation).toMatchObject({
      type: "capture",
      leaseId: project.id,
      phase: "uncertain",
    });
    resetPluginStateStoreForTests();
    const restarted = manager();
    calls.length = 0;
    await expect(restarted.capture(project)).rejects.toThrow("capture is unresolved");
    expect(calls).toEqual([]);
    expect(() => restarted.markEnrolled(project.id)).toThrow("capture is unresolved");
    await restarted.release(project);
    expect(restarted.lookupLease(project.id)).toBeUndefined();
    expect(openWarmImageStore().entries()[0]?.value.operation?.type).toBe("capture");
  });

  it("refuses a full profile before allocation while allowing an existing cold replay", async () => {
    const { manager, context, calls } = fixture();
    const initial = manager();
    await initial.allocate(context("cbx_existing"));
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    const allocations: WarmProfileRecord["allocations"] = { ...entry.value.allocations };
    for (let index = 1; index < 256; index++) {
      allocations[`cbx_pending_${index}`] = {
        ...entry.value.allocations.cbx_existing!,
      };
    }
    store.register(entry.key, { ...entry.value, allocations });
    resetPluginStateStoreForTests();
    const reopened = manager();
    calls.length = 0;
    await expect(reopened.allocate(context("cbx_rejected"))).rejects.toThrow("capacity is full");
    expect(calls).toEqual([]);
    await reopened.allocate(context("cbx_existing"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    await reopened.release(context("cbx_existing"));
    calls.length = 0;
    await reopened.allocate(context("cbx_rejected"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    expect(reopened.lookupLease("cbx_rejected")?.choice).toEqual({ kind: "cold" });
  });

  it("captures newly completed setup only from the current image generation", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const source = context("cbx_source", "project-a");
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    const next = context("cbx_completed", "project-a");
    const stale = context("cbx_stale", "project-a");
    await owner.allocate(next);
    await owner.allocate(stale);
    owner.markPrepared(next.id, "a".repeat(40));
    calls.length = 0;
    await owner.capture(next);
    expect(calls.some((argv) => argv[2] === "create")).toBe(false);
    await owner.capture({ ...next, projectCaptureRequired: true });
    expect(openWarmImageStore().entries()[0]?.value.image?.checkpointId).toBe(`${CHECKPOINT_ID}_2`);
    const captures = calls.filter((argv) => argv[2] === "create").length;
    owner.markPrepared(stale.id, "a".repeat(40));
    await owner.capture({ ...stale, projectCaptureRequired: true });
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(captures);
    expect(captures).toBe(1);
  });

  it("captures a verified prepared project once and never captures its enrolled session", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const project = context("cbx_first", "project-a");
    await owner.allocate(project);
    await owner.capture(project);
    expect(calls.some((argv) => argv[2] === "create")).toBe(false);
    owner.markPrepared(project.id, "a".repeat(40));
    await owner.capture(project);
    const image = openWarmImageStore().entries()[0]?.value.image;
    expect(image).toMatchObject({ checkpointId: CHECKPOINT_ID, baseCommit: "a".repeat(40) });
    owner.markEnrolled(project.id);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
    calls.length = 0;
    await owner.capture(project);
    expect(calls.some((argv) => argv[1] === "run" || argv[2] === "create")).toBe(false);
    await owner.release(project);
    resetPluginStateStoreForTests();
    const restarted = manager();
    await restarted.allocate(context("cbx_next", "project-a"));
    expect(calls.find((argv) => argv[2] === "fork")?.[3]).toBe(CHECKPOINT_ID);
    calls.length = 0;
    await restarted.allocate(context("cbx_other", "project-b"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    expect(restarted.lookupLease("cbx_next")).toMatchObject({
      projectKey: "project-a",
      machineClass: "standard",
      phase: "pending",
    });
  });
});
