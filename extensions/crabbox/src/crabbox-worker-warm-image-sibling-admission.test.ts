import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { operationLeaseId, resolveCrabboxWarmImageProfileKey } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { CrabboxCheckpointCreateError } from "./crabbox-worker-warm-image-checkpoint.js";
import {
  atWarmComparisonCommit,
  createSiblingFixture,
  currentAuthority,
  parsedProfile,
  profileKey,
  warmAllocation,
  warmImage,
  type WarmComparisonDelivery,
} from "./crabbox-worker-warm-image-sibling-admission.test-support.js";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";
import {
  checkpointResult,
  createProjectOptions,
  PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const noEnrollment = () =>
  vi.fn(async () => {
    throw new Error("Closed source must not begin node enrollment");
  });

const maintenanceContext = (authority = currentAuthority("maintenance")) => ({
  profiles: [PROFILE],
  signal: authority.signal,
  assertCurrent: authority.assertCurrent,
});

describe("Crabbox sibling native commit authority", () => {
  it("refuses replay display refresh before allocation dispatch", async () => {
    const f = createSiblingFixture();
    const source = currentAuthority();
    const operationId = "sibling-replay";
    const leaseId = operationLeaseId(operationId);
    const before: WarmProfileRecord = {
      version: 3,
      profileId: "old-display",
      allocations: { [leaseId]: warmAllocation(), sibling: warmAllocation() },
    };
    await f.store.register(profileKey, before);
    const beginNodeEnrollment = noEnrollment();
    const gate = atWarmComparisonCommit((row) => row.profileId === "new-display", source.close);
    const result = await gate.run(() =>
      provisionWarmProfile(f.provider, PROFILE, operationId, undefined, {
        signal: source.signal,
        assertCurrent: source.assertCurrent,
        profileId: "new-display",
        beginNodeEnrollment,
      }),
    );
    const durable = await f.reopen();
    gate.expectDecision(source.closed);
    expect
      .soft(result)
      .toMatchObject({ status: "rejected", error: { code: "PLUGIN_STATE_WRITE_FAILED" } });
    expect.soft(durable).toEqual(before);
    expect(source.signal.aborted).toBe(false);
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
    expect(f.calls.filter(({ argv }) => argv[1] !== "config")).toEqual([]);
  });

  it("refuses post-fork metadata and independently stops the dispatched lease before releasing its hold", async () => {
    const source = currentAuthority();
    const operationId = "sibling-fork";
    const leaseId = operationLeaseId(operationId);
    // This ledger models the external command fixture, not live cloud-resource proof.
    const live = new Set<string>();
    const f = createSiblingFixture(async ({ argv, options }) => {
      if (argv[1] === "checkpoint" && argv[2] === "fork") {
        live.add(argv[argv.indexOf("--lease-id") + 1]!);
      }
      if (argv[1] === "stop") {
        expect(options.signal).toBeUndefined();
        expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
        // The real stop owner has not received its successful response yet.
        expect((await f.store.lookup(profileKey))?.allocations[leaseId]).toBeDefined();
        expect(live.has(leaseId)).toBe(true);
        live.delete(leaseId);
        return commandResult();
      }
      return undefined;
    });
    const image = warmImage({ state: "pending", lastDemandAtMs: Date.now() - 1_000 });
    const before: WarmProfileRecord = {
      version: 3,
      image,
      allocations: { sibling: warmAllocation() },
    };
    await f.store.register(profileKey, before);
    const beginNodeEnrollment = noEnrollment();
    const gate = atWarmComparisonCommit(
      (row) => row.image?.state === "available" && Object.hasOwn(row.allocations, leaseId),
      source.close,
    );
    const result = await gate.run(() =>
      provisionWarmProfile(f.provider, PROFILE, operationId, undefined, {
        signal: source.signal,
        assertCurrent: source.assertCurrent,
        beginNodeEnrollment,
      }),
    );
    const durable = await f.reopen();
    gate.expectDecision(source.closed);
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "cleanup_complete", leaseId, provisionError: source.closed },
    });
    expect.soft(durable?.image).toEqual(image);
    expect(durable?.allocations).toEqual(before.allocations);
    expect(live.size).toBe(0);
    expect(source.signal.aborted).toBe(false);
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
    const fork = f.calls.findIndex(({ argv }) => argv[1] === "checkpoint" && argv[2] === "fork");
    expect(fork).toBeGreaterThanOrEqual(0);
    expect(f.calls.slice(fork + 1).map(({ argv }) => argv[1])).toEqual(["stop"]);
  });

  it.each(["scrubbing", "creating"] as const)(
    "refuses capture %s admission without dispatching native create",
    async (phase) => {
      const f = createSiblingFixture();
      const source = currentAuthority();
      const leaseId = "cbx_capture_boundary";
      const before: WarmProfileRecord = {
        version: 3,
        allocations: {
          [leaseId]: warmAllocation({ phase: "enrolled" }),
          sibling: warmAllocation(),
        },
      };
      await f.store.register(profileKey, before);
      const scrub = vi.fn(async () => {});
      const gate = atWarmComparisonCommit(
        (row) => row.operation?.type === "capture" && row.operation.phase === phase,
        source.close,
      );
      const result = await gate.run(() =>
        f.manager.capture(
          {
            id: leaseId,
            binary: "crabbox",
            provider: "aws",
            profile: parsedProfile,
            signal: source.signal,
            assertCurrent: source.assertCurrent,
          },
          scrub,
        ),
      );
      const durable = await f.reopen();
      // A forbidden scrubbing claim can later be cleared; a granted creating
      // transition can become uncertainty. Assert native refusal, not just cleanup.
      gate.expectDecision(source.closed);
      expect(result).toEqual({ status: "rejected", error: source.closed });
      expect(durable).toEqual(before);
      expect(scrub).toHaveBeenCalledTimes(phase === "scrubbing" ? 0 : 1);
      expect(f.runCommand).not.toHaveBeenCalled();
      expect(source.signal.aborted).toBe(false);
    },
  );

  it("refuses an expired-image retirement claim through provider maintenance", async () => {
    const f = createSiblingFixture();
    const pass = currentAuthority("maintenance pass");
    const before: WarmProfileRecord = {
      version: 3,
      allocations: {},
      image: warmImage({ createdAtMs: 0, lastDemandAtMs: 0 }),
    };
    await f.store.register(profileKey, before);
    const gate = atWarmComparisonCommit((row) => row.operation?.type === "retire", pass.close);
    const result = await gate.run(() => f.provider.maintain!(maintenanceContext(pass)));
    const durable = await f.reopen();
    gate.expectDecision(pass.closed);
    expect(result.status).toBe("rejected");
    expect.soft(durable).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(pass.signal.aborted).toBe(false);
  });

  it.each(["delete response", "native commit"] as const)(
    "settles confirmed single-catalog deletion when source closes at %s",
    async (boundary) => {
      const pass = currentAuthority("maintenance pass");
      const image = warmImage({ createdAtMs: 0, lastDemandAtMs: 0 });
      // One configured catalog confirms actual deletion, not partial absence
      // with another executable still unqueried. CLI effects remain modeled.
      const catalog = new Set([image.checkpointId]);
      const f = createSiblingFixture(({ argv, options }) => {
        expect(argv.slice(1)).toEqual(["checkpoint", "delete", image.checkpointId]);
        expect(options.signal?.aborted).toBe(false);
        const existed = catalog.delete(image.checkpointId);
        if (boundary === "delete response") {
          pass.close();
        }
        return commandResult({
          stdout:
            "checkpoint " + (existed ? "deleted" : "absent") + " id=" + image.checkpointId + "\n",
        });
      });
      const before: WarmProfileRecord = {
        version: 3,
        allocations: {},
        image,
        operation: { type: "retire", checkpointId: image.checkpointId },
      };
      await f.store.register(profileKey, before);
      const gate = atWarmComparisonCommit(
        (row) => !row.image && !row.operation,
        () => {
          if (boundary === "native commit") {
            pass.close();
          }
        },
      );
      const result = await gate.run(() => f.provider.maintain!(maintenanceContext(pass)));
      const durable = await f.reopen();
      expect(() => pass.assertCurrent()).toThrow(pass.closed);
      expect(pass.signal.aborted).toBe(false);
      expect(catalog.size).toBe(0);
      expect.soft(result.status).toBe("fulfilled");
      expect.soft(durable).toBeUndefined();
      expect(f.calls.map(({ argv }) => argv.slice(1))).toEqual([
        ["checkpoint", "delete", image.checkpointId],
      ]);
      expect(f.warn).not.toHaveBeenCalled();

      await f.provider.maintain!(maintenanceContext());
      expect(await f.reopen()).toBeUndefined();
      // Successful result custody must not require a second physical command.
      expect
        .soft(f.calls.map(({ argv }) => argv.slice(1)))
        .toEqual([["checkpoint", "delete", image.checkpointId]]);
      // The ORIGINAL native callback must allow the exact settlement SET in
      // both cases, even when logical authority closed before intent creation.
      gate.expectDecision();
    },
  );

  it("keeps guardless destroy capture and confirmed-stop retirement independent of plugin lifetime", async () => {
    const leaseId = "cbx_lifetime_custody";
    const image = warmImage({ createdAtMs: Date.now() - 86_400_001 });
    const live = new Set([leaseId]);
    const catalog = new Set([image.checkpointId]);
    const f = createSiblingFixture(async ({ argv, options }) => {
      expect(options.signal).toBeUndefined();
      if (argv[1] === "checkpoint" && argv[2] === "inspect") {
        return undefined;
      }
      if (argv[1] === "checkpoint" && argv[2] === "create") {
        catalog.add("chk_lifetime_returned");
        return checkpointResult("chk_lifetime_returned", leaseId, "completed");
      }
      if (argv[1] === "stop") {
        expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
        const current = await f.store.lookup(profileKey);
        expect(current?.allocations[leaseId]).toBeDefined();
        expect(current?.image?.checkpointId).toBe("chk_lifetime_returned");
        expect(current?.operation).toEqual({ type: "retire", checkpointId: image.checkpointId });
        live.delete(leaseId);
        return commandResult();
      }
      if (argv[1] === "checkpoint" && argv[2] === "delete") {
        expect(live.size).toBe(0);
        expect((await f.store.lookup(profileKey))?.allocations[leaseId]).toBeUndefined();
        expect(argv[3]).toBe(image.checkpointId);
        catalog.delete(image.checkpointId);
        return commandResult();
      }
      expect(argv[1]).toBe("run");
      return commandResult();
    });
    await f.store.register(profileKey, {
      version: 3,
      image,
      allocations: {
        [leaseId]: warmAllocation({
          phase: "enrolled",
          choice: { kind: "checkpoint", checkpointId: image.checkpointId },
          imageGeneration: { checkpointId: image.checkpointId, createdAtMs: image.createdAtMs },
        }),
      },
    });
    await f.provider.images.pin(image.checkpointId, false);
    const bound = f.store.withCurrent({ assertCurrent() {} });
    f.lifetime.close();
    // Prove this is the actual factory lifecycle check, not a fixture no-op.
    await expect(bound.observe(profileKey)).rejects.toThrow(f.lifetime.closed.message);
    expect(() => f.store.withCurrent({ assertCurrent() {} })).toThrow(f.lifetime.closed);
    await f.provider.destroy({ leaseId, profile: PROFILE });
    const durable = await f.reopen();
    expect(f.lifetime.assertCurrent).toHaveBeenCalled();
    expect(f.lifetime.signal.aborted).toBe(false);
    expect(durable?.image?.checkpointId).toBe("chk_lifetime_returned");
    expect(durable?.allocations).toEqual({});
    expect(durable?.operation).toBeUndefined();
    expect(live.size).toBe(0);
    expect([...catalog]).toEqual(["chk_lifetime_returned"]);
    expect(f.calls.map(({ argv }) => (argv[1] === "checkpoint" ? argv[2] : argv[1]))).toEqual([
      "inspect",
      "run",
      "create",
      "stop",
      "delete",
    ]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("keeps already-earned demand unbound when prior source and plugin lifetime close at its CAS commit", async () => {
    const f = createSiblingFixture();
    const source = currentAuthority();
    const leaseId = "cbx_historical_demand";
    const preparationKey = "c".repeat(64);
    const cacheKey = "d".repeat(64);
    const image = warmImage({ preparationKey, cacheKey, purpose: "session", lastDemandAtMs: 10 });
    const before: WarmProfileRecord = {
      version: 3,
      image,
      allocations: {
        [leaseId]: warmAllocation({
          phase: "enrolled",
          preparationKey,
          cacheKey,
          purpose: "session",
          imageGeneration: { checkpointId: image.checkpointId, createdAtMs: image.createdAtMs },
        }),
      },
    };
    await f.store.register(profileKey, before);
    await f.manager.markEnrolled(leaseId, source.assertCurrent);
    const gate = atWarmComparisonCommit(
      (row) => row.image?.lastDemandAtMs === 20,
      () => {
        source.close();
        f.lifetime.close();
      },
    );
    const result = await gate.run(() =>
      f.manager.notePreparedDemand(leaseId, { preparationKey, demandAtMs: 20 }),
    );
    const durable = await f.reopen();
    gate.expectDecision();
    expect(() => source.assertCurrent()).toThrow(source.closed);
    expect(result.status).toBe("fulfilled");
    expect(durable).toEqual({ ...before, image: { ...image, lastDemandAtMs: 20 } });
    expect(source.signal.aborted).toBe(false);
    expect(f.lifetime.signal.aborted).toBe(false);
    expect(() => f.store.withCurrent({ assertCurrent() {} })).toThrow(f.lifetime.closed);
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  function captureDispatchRecord(leaseId: string) {
    const image = warmImage({ createdAtMs: 0 });
    return {
      version: 3 as const,
      image,
      allocations: {
        [leaseId]: warmAllocation({
          phase: "enrolled",
          choice: { kind: "checkpoint", checkpointId: image.checkpointId },
          imageGeneration: { checkpointId: image.checkpointId, createdAtMs: image.createdAtMs },
        }),
        sibling: warmAllocation(),
      },
    };
  }

  it.each(["logical closure", "physical abort"] as const)(
    "capture dispatch custody clears an undispatched create after final grant on %s",
    async (boundary) => {
      const f = createSiblingFixture();
      const source = currentAuthority();
      const physical = new AbortController();
      const failure =
        boundary === "logical closure"
          ? source.closed
          : new DOMException("Synthetic physical Stop", "AbortError");
      const leaseId = "cbx_capture_not_dispatched";
      const before = captureDispatchRecord(leaseId);
      await f.store.register(profileKey, before);
      const scrub = vi.fn(async () => {});
      const gate = atWarmComparisonCommit(
        (row) => row.operation?.type === "capture" && row.operation.phase === "creating",
        () => {
          if (boundary === "logical closure") {
            source.close();
          } else {
            physical.abort(failure);
          }
        },
        "after grant",
      );
      const result = await gate.run(() =>
        f.manager.capture(
          {
            id: leaseId,
            binary: "crabbox",
            provider: "aws",
            profile: parsedProfile,
            forkedCheckpointId: before.image.checkpointId,
            signal: physical.signal,
            assertCurrent: source.assertCurrent,
          },
          scrub,
        ),
      );
      const durable = await f.reopen();
      gate.expectDecision();
      expect(result).toEqual({ status: "rejected", error: failure });
      expect("error" in result ? result.error : undefined).toBe(failure);
      expect(scrub).toHaveBeenCalledOnce();
      expect(f.runCommand).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
      expect(physical.signal.aborted).toBe(boundary === "physical abort");
      if (boundary === "logical closure") {
        expect(() => source.assertCurrent()).toThrow(source.closed);
      } else {
        expect(physical.signal.reason).toBe(failure);
        expect(() => source.assertCurrent()).not.toThrow();
      }
      // Creating was genuinely granted, but no command acquired result custody.
      // Keep every image/allocation fact and remove only this capture claim.
      expect.soft(durable).toEqual(before);
      expect.soft(durable?.operation).toBeUndefined();
      expect.soft(f.managerWarn).not.toHaveBeenCalledWith(expect.stringContaining("--recover"));
    },
  );

  it.each([
    {
      name: "capture dispatch custody retains an ambiguous result after native create dispatch",
      runner: "nonzero",
    },
    {
      name: "capture dispatch custody retains uncertainty after a synchronous runner throw",
      runner: "throw",
    },
    {
      name: "capture dispatch custody retains uncertainty after a rejected runner promise",
      runner: "reject",
    },
  ] as const)("$name", async ({ runner }) => {
    const source = currentAuthority();
    const physical = new AbortController();
    const leaseId = "cbx_capture_dispatched";
    const creatingClaims: Array<Extract<WarmProfileRecord["operation"], { type: "capture" }>> = [];
    const f = createSiblingFixture(undefined, async (delivery) => {
      const intent = delivery.intent;
      if (
        delivery.namespace !== "warm-images" ||
        delivery.key !== profileKey ||
        intent.operation !== "update" ||
        intent.action !== "set" ||
        !isRecord(intent.value) ||
        !isRecord(intent.value.operation) ||
        intent.value.operation.phase !== "creating"
      ) {
        return;
      }
      expect(delivery.result.status).toBe("applied");
      const row = await f.store.lookup(profileKey);
      if (
        row?.operation?.type !== "capture" ||
        row.operation.phase !== "creating" ||
        row.operation.id !== intent.value.operation.id
      ) {
        throw new Error("Native create reached the runner without its durable creating claim");
      }
      creatingClaims.push(row.operation);
    });
    const before = captureDispatchRecord(leaseId);
    await f.store.register(profileKey, before);
    f.runCommand.mockImplementation((argv, options) => {
      expect(argv.slice(0, 3)).toEqual(["crabbox", "checkpoint", "create"]);
      expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
      expect(options.signal?.aborted).toBe(false);
      expect(creatingClaims).toHaveLength(1);
      expect(creatingClaims[0]?.leaseId).toBe(leaseId);
      expect(() => source.assertCurrent()).not.toThrow();
      source.close();
      // The original creating CAS was observed before this synchronous handoff.
      // None of these runner outcomes attests native non-submission.
      const failure = new Error("synthetic checkpoint create response lost");
      if (runner === "throw") {
        throw failure;
      }
      return runner === "reject"
        ? Promise.reject(failure)
        : Promise.resolve(
            commandResult({
              code: 7,
              stderr: failure.message,
            }),
          );
    });
    const gate = atWarmComparisonCommit(
      (row) => row.operation?.type === "capture" && row.operation.phase === "creating",
      () => {},
      "after grant",
    );
    const scrub = vi.fn(async () => {});
    const result = await gate.run(() =>
      f.manager.capture(
        {
          id: leaseId,
          binary: "crabbox",
          provider: "aws",
          profile: parsedProfile,
          forkedCheckpointId: before.image.checkpointId,
          signal: physical.signal,
          assertCurrent: source.assertCurrent,
        },
        scrub,
      ),
    );
    const durable = await f.reopen();
    gate.expectDecision();
    expect(result).toEqual({ status: "rejected", error: source.closed });
    expect("error" in result ? result.error : undefined).toBe(source.closed);
    expect(() => source.assertCurrent()).toThrow(source.closed);
    expect(physical.signal.aborted).toBe(false);
    expect(scrub).toHaveBeenCalledOnce();
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
    expect(creatingClaims).toHaveLength(1);
    const creating = creatingClaims[0]!;
    expect(creating).toMatchObject({ leaseId, provider: "aws", phase: "creating" });
    expect(durable).toEqual({ ...before, operation: { ...creating, phase: "uncertain" } });
    expect(f.managerWarn).toHaveBeenCalledWith(expect.stringContaining("--recover " + creating.id));
  });

  function freshScrubbingSelector(delivery: WarmComparisonDelivery, key: string, leaseId: string) {
    const { intent } = delivery;
    if (
      delivery.namespace !== "warm-images" ||
      delivery.key !== key ||
      intent.operation !== "update" ||
      intent.action !== "set"
    ) {
      return undefined;
    }
    const row = intent.value;
    if (
      !isRecord(row) ||
      !isRecord(row.allocations) ||
      !Object.hasOwn(row.allocations, leaseId) ||
      !isRecord(row.operation)
    ) {
      return undefined;
    }
    const operation = row.operation;
    return operation.type === "capture" &&
      operation.phase === "scrubbing" &&
      operation.leaseId === leaseId &&
      typeof operation.id === "string"
      ? operation.id
      : undefined;
  }

  it("capture claim delivery custody clears its committed fresh claim and fails required project before enrollment", async () => {
    const operationId = "fresh-scrubbing-reply-lost";
    const leaseId = operationLeaseId(operationId);
    const { options } = createProjectOptions([]);
    const key = resolveCrabboxWarmImageProfileKey(parsedProfile, options.project.key);
    const deliveryFailure = new Error("synthetic scrubbing claim delivery lost");
    const committedClaims: string[] = [];
    const f = createSiblingFixture(
      async ({ argv, options: commandOptions }) => {
        if (argv[1] === "stop") {
          expect(commandOptions.signal).toBeUndefined();
          expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
          expect((await f.store.lookup(key))?.allocations[leaseId]).toBeDefined();
        }
        return undefined;
      },
      async (delivery) => {
        const selector = freshScrubbingSelector(delivery, key, leaseId);
        if (!selector) {
          return;
        }
        if (delivery.result.status !== "applied") {
          throw new Error("Fixture requires the original scrubbing CAS to have applied");
        }
        const persisted = await f.store.lookup(key);
        if (
          persisted?.operation?.type !== "capture" ||
          persisted.operation.id !== selector ||
          persisted.operation.phase !== "scrubbing"
        ) {
          throw new Error("Fixture did not observe the exact committed scrubbing claim");
        }
        committedClaims.push(selector);
        // The ORIGINAL raw/bound comparison already committed. Only its caller's
        // delivery fails; do not replay or replace that mutation.
        throw deliveryFailure;
      },
    );
    const before: WarmProfileRecord = {
      version: 3,
      projectKey: options.project.key,
      allocations: { sibling: warmAllocation() },
    };
    await f.store.register(key, before);
    const result = await f.provider.provision(PROFILE, operationId, options).then(
      (lease) => ({ status: "fulfilled" as const, lease }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const durable = await f.reopen(key);
    expect(committedClaims).toHaveLength(1);
    expect(options.signal.aborted).toBe(false);
    expect(() => options.assertCurrent()).not.toThrow();
    expect(options.project.prepare).toHaveBeenCalledOnce();
    expect(options.prepareNodeRuntime).not.toHaveBeenCalled();
    expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
    expect(
      f.calls
        .filter(({ argv }) => argv[1] === "run")
        .map(({ options: commandOptions }) => commandOptions.input),
    ).toEqual(["project-checkout"]);
    expect(f.calls.some(({ argv }) => argv[1] === "checkpoint" && argv[2] === "create")).toBe(
      false,
    );
    expect(f.calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
    expect(
      f.calls
        .filter(({ argv }) => argv[1] === "stop")
        .map(({ argv }) => argv[argv.indexOf("--id") + 1]),
    ).toEqual([leaseId]);
    expect.soft(result).toMatchObject({
      status: "rejected",
      error: { code: "cleanup_complete", leaseId, provisionError: deliveryFailure },
    });
    const error = "error" in result ? result.error : undefined;
    expect.soft(isRecord(error) ? error.provisionError : undefined).toBe(deliveryFailure);
    // Confirmed Stop removes only the source allocation. A still-live source must
    // not convert the failed required capture into enrollment after claim cleanup.
    expect
      .soft(durable)
      .toEqual({ ...before, backend: "aws", machineClass: "standard", os: "linux" });
    expect.soft(durable?.operation).toBeUndefined();
  });

  it("capture claim delivery custody never clears a replacement selector after its own reply is lost", async () => {
    const source = currentAuthority();
    const leaseId = "cbx_replaced_scrubbing_reply";
    const deliveryFailure = new Error("synthetic replaced-claim delivery lost");
    const committedClaims: string[] = [];
    const replacements: WarmProfileRecord[] = [];
    const f = createSiblingFixture(undefined, async (delivery) => {
      const selector = freshScrubbingSelector(delivery, profileKey, leaseId);
      if (!selector) {
        return;
      }
      if (delivery.result.status !== "applied") {
        throw new Error("Fixture requires the original scrubbing CAS to have applied");
      }
      const persisted = await f.store.lookup(profileKey);
      if (
        persisted?.operation?.type !== "capture" ||
        persisted.operation.id !== selector ||
        persisted.operation.phase !== "scrubbing"
      ) {
        throw new Error("Fixture did not observe the exact committed scrubbing claim");
      }
      committedClaims.push(selector);
      const replacement: WarmProfileRecord = {
        ...persisted,
        operation: {
          ...persisted.operation,
          id: "replacement-capture-selector",
          startedAtMs: persisted.operation.startedAtMs + 1,
          phase: "creating",
        },
      };
      // A separate real async write installs another selector before delivery
      // fails. Cleanup may reconcile this invocation's selector, never the new one.
      await f.store.register(profileKey, replacement);
      replacements.push(replacement);
      source.close();
      throw deliveryFailure;
    });
    const before = captureDispatchRecord(leaseId);
    await f.store.register(profileKey, before);
    const scrub = vi.fn(async () => {});
    const result = await f.manager
      .capture(
        {
          id: leaseId,
          binary: "crabbox",
          provider: "aws",
          profile: parsedProfile,
          forkedCheckpointId: before.image.checkpointId,
          signal: source.signal,
          assertCurrent: source.assertCurrent,
        },
        scrub,
      )
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    const durable = await f.reopen();
    expect(committedClaims).toHaveLength(1);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.operation?.type).toBe("capture");
    expect(committedClaims[0]).not.toBe("replacement-capture-selector");
    expect(result).toEqual({ status: "rejected", error: source.closed });
    expect("error" in result ? result.error : undefined).toBe(source.closed);
    expect(source.signal.aborted).toBe(false);
    expect(scrub).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(durable).toEqual(replacements[0]);
  });

  it.each([
    { failure: "not_submitted", cleanup: "refused" },
    { failure: "not_submitted", cleanup: "cleared" },
    { failure: "not_submitted", cleanup: "replacement" },
    { failure: "claim delivery", cleanup: "refused" },
  ] as const)(
    "capture recovery precedence preserves the original $failure error with exact cleanup $cleanup",
    async ({ failure, cleanup }) => {
      const source = currentAuthority();
      const leaseId = "cbx_capture_recovery_precedence";
      const { options } = createProjectOptions([]);
      const key = resolveCrabboxWarmImageProfileKey(parsedProfile, options.project.key);
      const deliveryFailure = new Error("synthetic fresh claim response lost");
      const storageFailure = new Error("synthetic exact capture cleanup refused");
      const claims: Array<Extract<WarmProfileRecord["operation"], { type: "capture" }>> = [];
      const f = createSiblingFixture(undefined, async (delivery) => {
        const selector = freshScrubbingSelector(delivery, key, leaseId);
        if (failure !== "claim delivery" || !selector) {
          return;
        }
        expect(delivery.result.status).toBe("applied");
        const persisted = await f.store.lookup(key);
        if (persisted?.operation?.type !== "capture" || persisted.operation.id !== selector) {
          throw new Error("Original claim CAS must be durable before its reply fails");
        }
        claims.push(persisted.operation);
        throw deliveryFailure;
      });
      const initial = captureDispatchRecord(leaseId);
      const before: WarmProfileRecord = {
        ...initial,
        projectKey: options.project.key,
        allocations: {
          ...initial.allocations,
          [leaseId]: { ...initial.allocations[leaseId]!, phase: "prepared" },
        },
      };
      await f.store.register(key, before);
      let replacement: WarmProfileRecord | undefined;
      f.runCommand.mockImplementation(async (argv, commandOptions) => {
        expect(argv.slice(0, 3)).toEqual(["crabbox", "checkpoint", "create"]);
        expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
        expect(commandOptions.signal?.aborted).toBe(false);
        const persisted = await f.store.lookup(key);
        if (persisted?.operation?.type !== "capture" || persisted.operation.phase !== "creating") {
          throw new Error("Native create requires the original durable creating claim");
        }
        claims.push(persisted.operation);
        if (cleanup === "replacement") {
          // Same lease, different selector: lease identity cannot authorize its cleanup
          // or turn this attempt's original error into another capture's recovery error.
          replacement = {
            ...persisted,
            operation: { ...persisted.operation, id: "successor-capture-selector" },
          };
          await f.store.register(key, replacement);
        }
        return commandResult({
          code: 7,
          stderr: "synthetic native capture rejected before submission",
          stdout: JSON.stringify({
            schema: "crabbox.checkpoint.create.failure.v1",
            outcome: "not_submitted",
            provider: "aws",
            leaseId,
            checkpointId: "chk_recovery_precedence",
            localReservation: "removed",
          }),
        });
      });
      // Observe the real parser's error and verdict; never fabricate a typed receipt/error.
      const receipt = vi.spyOn(CrabboxCheckpointCreateError, "wasNotSubmitted");
      const gate =
        cleanup === "refused"
          ? atWarmComparisonCommit(
              (row) => !row.operation && Object.hasOwn(row.allocations, leaseId),
              () => {
                throw storageFailure;
              },
              "before grant",
              key,
            )
          : undefined;
      const scrub = vi.fn(async () => {});
      const capture = () =>
        f.manager.capture(
          {
            id: leaseId,
            binary: "crabbox",
            provider: "aws",
            profile: parsedProfile,
            forkedCheckpointId: before.image!.checkpointId,
            signal: source.signal,
            assertCurrent: source.assertCurrent,
          },
          scrub,
        );
      const result = gate
        ? await gate.run(capture)
        : await capture().then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
      const durable = await f.reopen(key);
      gate?.expectDecision(storageFailure);
      expect(claims).toHaveLength(1);
      const claim = claims[0]!;
      expect(claim).toMatchObject({
        leaseId,
        provider: "aws",
        phase: failure === "not_submitted" ? "creating" : "scrubbing",
      });
      expect(f.runCommand).toHaveBeenCalledTimes(failure === "not_submitted" ? 1 : 0);
      expect(scrub).toHaveBeenCalledTimes(failure === "not_submitted" ? 1 : 0);
      expect(f.calls).toEqual([]);
      expect(source.signal.aborted).toBe(false);
      expect(() => source.assertCurrent()).not.toThrow();
      expect(result.status).toBe("rejected");
      const error = "error" in result ? result.error : undefined;
      const original = failure === "not_submitted" ? receipt.mock.calls[0]?.[0] : deliveryFailure;
      if (failure === "not_submitted") {
        // Pure receipt classification may repeat; native dispatch cardinality is checked above.
        expect(original).toBeInstanceOf(CrabboxCheckpointCreateError);
        expect(receipt.mock.results).toHaveLength(receipt.mock.calls.length);
        for (const [index, [observedError, context]] of receipt.mock.calls.entries()) {
          expect(observedError).toBe(original);
          expect(context).toMatchObject({ provider: "aws", id: leaseId });
          expect(receipt.mock.results[index]).toEqual({ type: "return", value: true });
        }
      } else {
        expect(receipt).not.toHaveBeenCalled();
      }
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error) || !(original instanceof Error)) {
        throw new Error("Capture must reject with its observed original failure");
      }
      expect(error.message).toContain(original.message);
      if (cleanup === "refused") {
        expect(durable).toEqual({ ...before, operation: claim });
        // Native non-submission says nothing about this local SQLite claim's cleanup.
        // This is the intended RED assertion, after proving the exact retained selector.
        expect.soft(error.message).toContain("--recover " + claim.id);
      } else {
        expect(error).toBe(original);
        expect(error.message).not.toContain("--recover");
        expect(f.managerWarn).not.toHaveBeenCalledWith(expect.stringContaining("--recover"));
        expect(durable).toEqual(cleanup === "replacement" ? replacement : before);
      }
    },
  );

  it("keeps a live project capture successful when post-publication retirement settlement is refused", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const source = currentAuthority("project capture");
    const leaseId = "cbx_post_publication_settlement";
    const { options } = createProjectOptions([]);
    const key = resolveCrabboxWarmImageProfileKey(parsedProfile, options.project.key);
    const storageFailure = new Error("synthetic post-publication retirement settlement refused");
    const checkpointId = "chk_post_publication_returned";
    const image = warmImage({
      checkpointId: "chk_post_publication_current",
      createdAtMs: now - 1_000,
      preparationKey: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "reserve",
      lastDemandAtMs: now,
      baseCommit: options.project.baseCommit,
      runtimeIdentity: options.nodeRuntimeIdentity,
    });
    const previous = {
      ...image,
      checkpointId: "chk_post_publication_previous",
      createdAtMs: now - 2_000,
    };
    const allocation = warmAllocation({
      phase: "prepared",
      choice: { kind: "checkpoint", checkpointId: image.checkpointId },
      imageGeneration: { checkpointId: image.checkpointId, createdAtMs: image.createdAtMs },
      preparationKey: image.preparationKey,
      cacheKey: image.cacheKey,
      purpose: image.purpose,
      demandAtMs: now,
      baseCommit: options.project.baseCommit,
      runtimeIdentity: options.nodeRuntimeIdentity,
    });
    const before: WarmProfileRecord = {
      version: 3,
      projectKey: options.project.key,
      image,
      previous,
      allocations: { [leaseId]: allocation, sibling: warmAllocation() },
    };
    const published: WarmProfileRecord = {
      ...before,
      image: { ...image, checkpointId, createdAtMs: now },
      previous: image,
      allocations: {
        ...before.allocations,
        [leaseId]: { ...allocation, imageGeneration: { checkpointId, createdAtMs: now } },
      },
      operation: { type: "retire", checkpointId: previous.checkpointId },
    };
    // Keep both live-demand generations through the initial sweep. Publication
    // retains the borrowed current and retires only the unheld older previous.
    const f = createSiblingFixture(undefined, undefined, {
      refreshAfterMs: 86_400_000,
      retainUnusedMs: 14 * 86_400_000,
      keepPrevious: 1,
    });
    await f.store.register(key, before);
    // This catalog models CLI effects only; SQLite, worker, CAS, and grants are real.
    const catalog = new Set([image.checkpointId, previous.checkpointId]);
    const events: string[] = [];
    const creatingClaims: Array<Extract<WarmProfileRecord["operation"], { type: "capture" }>> = [];
    let observedPublication: WarmProfileRecord | undefined;
    f.runCommand.mockImplementation(async (argv, commandOptions) => {
      expect(commandOptions.signal?.aborted).toBe(false);
      expect(() => source.assertCurrent()).not.toThrow();
      if (argv[2] === "create") {
        expect(argv.slice(0, 3)).toEqual(["crabbox", "checkpoint", "create"]);
        expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
        const row = await f.store.lookup(key);
        if (row?.operation?.type !== "capture" || row.operation.phase !== "creating") {
          throw new Error("Native create requires its durable creating claim");
        }
        expect(row).toEqual({ ...before, operation: row.operation });
        expect(row.operation).toMatchObject({ leaseId, provider: "aws", startedAtMs: now });
        creatingClaims.push(row.operation);
        events.push("create");
        catalog.add(checkpointId);
        return checkpointResult(checkpointId, leaseId, "completed");
      }
      expect(argv).toEqual(["crabbox", "checkpoint", "delete", previous.checkpointId]);
      observedPublication = await f.store.lookup(key);
      expect(observedPublication).toEqual(published);
      events.push("published");
      expect(catalog.delete(previous.checkpointId)).toBe(true);
      events.push("delete");
      return commandResult({ stdout: "checkpoint deleted id=" + previous.checkpointId + "\n" });
    });
    const gate = atWarmComparisonCommit(
      (row) =>
        !row.operation &&
        row.image?.checkpointId === checkpointId &&
        row.previous?.checkpointId === image.checkpointId &&
        row.allocations[leaseId]?.imageGeneration?.checkpointId === checkpointId,
      () => {
        // Refuse only settlement, never the publication CAS or source authority.
        expect(events).toEqual(["create", "published", "delete"]);
        expect(catalog.has(previous.checkpointId)).toBe(false);
        expect(() => source.assertCurrent()).not.toThrow();
        throw storageFailure;
      },
      "before grant",
      key,
    );
    const scrub = vi.fn(async () => {});
    const result = await gate.run(() =>
      f.manager.capture(
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
      ),
    );
    const durable = await f.reopen(key);
    gate.expectDecision(storageFailure);
    expect(creatingClaims).toHaveLength(1);
    expect(observedPublication).toEqual(published);
    expect(events).toEqual(["create", "published", "delete"]);
    expect(f.runCommand.mock.calls.map(([argv]) => argv[2])).toEqual(["create", "delete"]);
    expect(scrub).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
    expect(source.signal.aborted).toBe(false);
    expect(() => source.assertCurrent()).not.toThrow();
    expect(() => f.lifetime.assertCurrent()).not.toThrow();
    expect(catalog).toEqual(new Set([image.checkpointId, checkpointId]));
    // A completed publication is not a failed required-project attempt. Its
    // exact retirement debt survives the refused commit; no capture needs recovery.
    expect.soft(result).toEqual({ status: "fulfilled", value: true });
    expect.soft(durable).toEqual(published);
    expect(durable?.operation).toEqual({ type: "retire", checkpointId: previous.checkpointId });
    expect(f.managerWarn).toHaveBeenCalledOnce();
    expect(f.managerWarn).not.toHaveBeenCalledWith(expect.stringContaining("--recover"));
    expect(f.managerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("capture is unresolved"),
    );
  });
});
