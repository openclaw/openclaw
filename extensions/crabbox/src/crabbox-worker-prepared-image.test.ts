import { describe, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import { firstWarmImage as warmImage, pause } from "./crabbox-warm-scenarios.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  BASE_COMMIT,
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  PROFILE,
  PROJECT_KEY,
  checkpointResult,
  createProjectOptions as projectOptions,
  createWarmProvider,
} from "./crabbox-worker-warm-image.test-support.js";

const captureResult = (argv: string[], id: string) =>
  checkpointResult(id, argv[argv.indexOf("--id") + 1]!, "available");
const preparedCapture = { seedKey: PROJECT_KEY, cacheHit: false, captureRequired: true as const };
const cachedPreparation = { seedKey: PROJECT_KEY, cacheHit: true };
const readyTarget = {
  machineClass: "fast",
  platform: "linux",
  profileKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
};

type Preparation = NonNullable<Parameters<typeof projectOptions>[2]>;

function createPreparation(purpose: Preparation["purpose"], demandAtMs = Date.now()): Preparation {
  return { key: "c".repeat(64), cacheKey: "d".repeat(64), purpose, demandAtMs };
}

function maintain(provider: ReturnType<typeof createWarmProvider>["provider"]) {
  return provider.maintain!({
    profiles: [PROFILE],
    signal: new AbortController().signal,
    assertCurrent() {},
  });
}

type Provider = ReturnType<typeof createWarmProvider>["provider"];
const stop = (provider: Provider, lease: { leaseId: string }, profile = PROFILE) =>
  destroyAndWait(provider, { leaseId: lease.leaseId, profile });
const noteDemand = (
  provider: Provider,
  lease: { leaseId: string },
  preparationKey: string,
  demandAtMs: number,
  profile = PROFILE,
) =>
  provider.notePreparedDemand!({ leaseId: lease.leaseId, profile }, { preparationKey, demandAtMs });

describe("Crabbox prepared image demand and custody", () => {
  it.each([0, 1] as const)(
    "keeps demand on its own generation with keepPrevious=%s",
    async (keepPrevious) => {
      const now = Date.now();
      const preparation = createPreparation("reserve", now);
      let captures = 0;
      const { provider, calls } = createWarmProvider(
        ({ argv }) =>
          argv[2] === "create" ? captureResult(argv, `chk_demand_${++captures}`) : undefined,
        undefined,
        {
          warmImagePolicy: {
            refreshAfterMs: 86_400_000,
            retainUnusedMs: 14 * 86_400_000,
            keepPrevious,
          },
        },
      );
      const seed = await provider.provision(
        PROFILE,
        "generation-seed",
        projectOptions([], undefined, preparation).options,
      );
      const borrower = await provider.provision(
        PROFILE,
        "generation-borrower",
        projectOptions([], undefined, { ...preparation, purpose: "session" }).options,
      );
      const next = projectOptions([], undefined, preparation);
      next.options.project.prepare.mockResolvedValueOnce(preparedCapture);
      const replacement = await provider.provision(PROFILE, "generation-replacement", next.options);
      expect(captures).toBe(2);
      await noteDemand(provider, borrower, preparation.key, now + 60_000);
      expect(await warmImage()).toMatchObject({
        checkpointId: "chk_demand_2",
        lastDemandAtMs: now,
      });
      expect(openWarmImageStore().entries()[0]?.value.previous?.lastDemandAtMs).toBe(
        keepPrevious ? now + 60_000 : undefined,
      );
      await noteDemand(provider, replacement, preparation.key, now + 60_000);
      expect((await warmImage())?.lastDemandAtMs).toBe(now + 60_000);
      await stop(provider, borrower);
      await stop(provider, replacement);
      expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
      await stop(provider, seed);
      expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual(
        keepPrevious ? [] : ["chk_demand_1"],
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 14 * 86_400_000);
      await maintain(provider);
      expect((await warmImage())?.previous?.checkpointId).toBe(
        keepPrevious ? "chk_demand_1" : undefined,
      );
      clock.mockReturnValue(now + 60_000 + 14 * 86_400_000);
      await maintain(provider);
      expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
    },
  );

  it("starts a changed-commit session before refreshing its image in a reserve", async () => {
    const events: string[] = [];
    const now = Date.now();
    const preparation = createPreparation("session", now);
    const profile = { ...PROFILE, setup: "synthetic-profile-setup" };
    let current = projectOptions(events, undefined, preparation);
    let captures = 0;
    const { provider, calls } = createWarmProvider((call) => {
      current.observe(call);
      return call.argv[2] === "create"
        ? captureResult(call.argv, ++captures === 1 ? CHECKPOINT_ID : "chk_commit_b")
        : undefined;
    });
    current.options.project.baseCommit = "a".repeat(40);
    const source = await provider.provision(profile, "prepared-source", current.options);
    expect(events.indexOf("capture")).toBeLessThan(events.indexOf("enrollment-begun"));
    await noteDemand(provider, source, preparation.key, now, profile);
    await stop(provider, source, profile);
    const next = { ...preparation, key: "e".repeat(64) };
    current = projectOptions(events, undefined, next);
    current.options.project.prepare.mockResolvedValueOnce(preparedCapture);
    calls.length = 0;
    const changed = await provider.provision(profile, "prepared-changed", current.options);
    expect(captures).toBe(1);
    expect(await warmImage()).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      baseCommit: "a".repeat(40),
      preparationKey: preparation.key,
      lastDemandAtMs: now,
      allocations: {
        [changed.leaseId]: {
          phase: "enrolled",
          baseCommit: BASE_COMMIT,
          preparationKey: next.key,
          choice: { kind: "checkpoint", checkpointId: CHECKPOINT_ID },
        },
      },
    });
    expect(current.options.project.prepare).toHaveBeenCalledOnce();
    expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
    expect(current.options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(calls.some(({ options }) => options.input === profile.setup)).toBe(false);
    await noteDemand(provider, changed, next.key, now + 60_000, profile);
    current = projectOptions(events, undefined, {
      ...next,
      purpose: "reserve",
      demandAtMs: now + 60_000,
    });
    current.options.project.prepare.mockResolvedValueOnce(preparedCapture);
    const reserve = await provider.provision(profile, "prepared-reserve", current.options);
    expect(captures).toBe(2);
    expect(await warmImage()).toMatchObject({
      checkpointId: "chk_commit_b",
      baseCommit: BASE_COMMIT,
      preparationKey: next.key,
      purpose: "reserve",
      lastDemandAtMs: now + 60_000,
      retirement: { checkpointId: CHECKPOINT_ID },
    });
    await stop(provider, changed, profile);
    await stop(provider, reserve, profile);
    current = projectOptions(events, undefined, { ...next, purpose: "session" });
    current.options.project.prepare.mockResolvedValueOnce(cachedPreparation);
    calls.length = 0;
    await provider.provision(profile, "prepared-repeat", current.options);
    expect(captures).toBe(2);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_commit_b");
    expect(
      calls.some(
        ({ options }) => options.input === profile.setup || options.input === "project-checkout",
      ),
    ).toBe(false);
    expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
    expect((await warmImage())?.lastDemandAtMs).toBe(now + 60_000);
  });

  it.each(["session", "aged session", "reserve"] as const)(
    "tops up an older runtime on a compatible %s fork and refreshes only at its capture boundary",
    async (scenario) => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const preparation = createPreparation("reserve", now);
      const events: string[] = [];
      let current = projectOptions(events, undefined, preparation);
      let captures = 0;
      const { provider, calls } = createWarmProvider((call) => {
        current.observe(call);
        return call.argv[2] === "create"
          ? captureResult(call.argv, `chk_runtime_${++captures}`)
          : undefined;
      });
      const source = await provider.provision(PROFILE, "runtime-source", current.options);
      await stop(provider, source);
      const image = structuredClone(openWarmImageStore().entries()[0]!.value.image);
      if (scenario === "aged session") {
        clock.mockReturnValue(now + 86_400_000);
      }
      current = projectOptions(events, undefined, {
        ...preparation,
        key: "e".repeat(64),
        purpose: scenario === "reserve" ? "reserve" : "session",
      });
      current.options.nodeRuntimeIdentity.nodeBootstrapSha256 = "f".repeat(64);
      events.length = 0;
      calls.length = 0;
      await provider.provision(PROFILE, "runtime-next", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_runtime_1");
      expect(current.options.prepareNodeRuntime).toHaveBeenCalledOnce();
      expect(events.indexOf("runtime-install")).toBeLessThan(events.indexOf("enrollment-begun"));
      expect(current.options.beginNodeEnrollment).toHaveBeenCalledOnce();
      expect(events).toContain("enrollment-install");
      expect(captures).toBe(scenario === "session" ? 1 : 2);
      if (scenario === "session") {
        expect(openWarmImageStore().entries()[0]!.value.image).toEqual(image);
      } else {
        expect(openWarmImageStore().entries()[0]!.value.image?.runtimeIdentity).toEqual(
          current.options.nodeRuntimeIdentity,
        );
      }
    },
  );

  it("preserves capture policy for a changed commit after interrupted preparation", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const preparation = createPreparation("reserve", now);
    let captures = 0;
    const { provider } = createWarmProvider(({ argv }) =>
      argv[2] === "create"
        ? captureResult(argv, ++captures === 1 ? CHECKPOINT_ID : "chk_commit_b")
        : undefined,
    );
    const source = projectOptions([], undefined, preparation);
    source.options.project.baseCommit = "a".repeat(40);
    const lease = await provider.provision(PROFILE, "capture-policy-source", source.options);
    await stop(provider, lease);
    const next = {
      ...preparation,
      key: "e".repeat(64),
      purpose: "session" as const,
      demandAtMs: Date.now(),
    };
    const controller = new AbortController();
    const interrupted = projectOptions([], controller, next);
    interrupted.options.project.prepare.mockImplementationOnce(async () => {
      controller.abort();
      return preparedCapture;
    });
    await expect(
      provider.provision(PROFILE, "capture-policy-changed", interrupted.options),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupted.options.beginNodeEnrollment).not.toHaveBeenCalled();
    const changed = projectOptions([], undefined, next);
    changed.options.project.prepare.mockResolvedValueOnce(cachedPreparation);
    await provider.provision(PROFILE, "capture-policy-changed", changed.options);
    expect(captures).toBe(2);
    expect(changed.options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect((await warmImage())?.baseCommit).toBe(BASE_COMMIT);
  });

  it("shares the release deadline after predecessor deletion consumes 60000 ms", async () => {
    let monotonicMs = 0;
    const performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const preparation = createPreparation("reserve", now);
    let captures = 0;
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[2] === "create") {
        return captureResult(argv, ++captures === 1 ? CHECKPOINT_ID : "chk_unactivated");
      }
      if (argv[2] === "delete" && argv[3] === CHECKPOINT_ID) {
        monotonicMs += 60_000;
      }
      return undefined;
    });
    const source = await provider.provision(
      PROFILE,
      "release-budget-source",
      projectOptions([], undefined, preparation).options,
    );
    try {
      await stop(provider, source);
      const current = projectOptions([], undefined, {
        ...preparation,
        key: "e".repeat(64),
        purpose: "session",
      });
      current.options.project.prepare.mockResolvedValueOnce(preparedCapture);
      current.options.beginNodeEnrollment.mockRejectedValueOnce(
        new Error("enrollment admission failed"),
      );
      await expect(
        provider.provision(PROFILE, "release-budget-session", current.options),
      ).rejects.toThrow("enrollment admission failed");
      const deletions = calls.filter(({ argv }) => argv[2] === "delete");
      expect(deletions[0]?.argv[3]).toBe(CHECKPOINT_ID);
      expect(deletions[0]?.options.timeoutMs).toBe(60_000);
      expect(deletions).toHaveLength(1);
      expect(await warmImage()).toMatchObject({
        allocations: {},
        lastDemandAtMs: null,
        retirement: { checkpointId: "chk_unactivated" },
      });
      await maintain(provider);
      expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
    } finally {
      performanceNowSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it.each(["success", "ambiguous"] as const)(
    "retains %s capture custody across reserve expiry without late enrollment or demand",
    async (outcome) => {
      const events: string[] = [];
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const expiresAtMs = now + 60_000;
      const preparation = createPreparation("session", now);
      const profile = { ...PROFILE, idleTimeout: "1m" };
      let current = projectOptions(events, undefined, preparation);
      current.options.project.baseCommit = "a".repeat(40);
      const capture = pause();
      const operationId = `capture-expiry-${outcome}`;
      const reserveId = operationLeaseId(operationId);
      let captureSignal: AbortSignal | undefined;
      const { provider, calls, warn } = createWarmProvider(async (call) => {
        current.observe(call);
        if (call.argv[2] !== "create" || !call.argv.includes(reserveId)) {
          return undefined;
        }
        captureSignal = call.options.signal;
        await capture.wait();
        return outcome === "success"
          ? checkpointResult("chk_late_capture", reserveId, "available")
          : commandResult({ code: 7, stderr: "capture response lost" });
      });
      const source = await provider.provision(profile, "capture-expiry-source", current.options);
      await noteDemand(provider, source, preparation.key, now, profile);
      await stop(provider, source, profile);
      calls.length = 0;
      const controller = new AbortController();
      current = projectOptions(events, controller, {
        ...preparation,
        key: "e".repeat(64),
        purpose: "reserve",
      });
      current.options.project.assertCurrent = () => {
        if (Date.now() >= expiresAtMs) {
          controller.abort(new DOMException("Prepared worker expired", "AbortError"));
        }
        controller.signal.throwIfAborted();
      };
      const provision = provider.provision(profile, operationId, current.options).then(
        (lease) => ({ lease }),
        (error: unknown) => ({ error }),
      );
      try {
        await capture.entered;
        clock.mockReturnValue(expiresAtMs + 1);
        expect(captureSignal?.aborted).toBe(false);
        expect(await warmImage()).toMatchObject({
          capture: { leaseId: reserveId, phase: "creating" },
          allocations: { [reserveId]: { phase: "prepared" } },
        });
        expect(current.options.beginNodeEnrollment).not.toHaveBeenCalled();
        expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
      } finally {
        capture.release();
        await provision;
      }
      await expect(provision).resolves.toMatchObject({
        error: { name: "AbortError", message: "Prepared worker expired" },
      });
      expect(current.options.beginNodeEnrollment).not.toHaveBeenCalled();
      const recorded = (await warmImage())!;
      expect(recorded.lastDemandAtMs).toBe(now);
      expect(recorded.allocations[reserveId]?.phase).toBe("prepared");
      if (outcome === "success") {
        expect(recorded).toMatchObject({
          checkpointId: "chk_late_capture",
          retirement: { checkpointId: CHECKPOINT_ID },
          allocations: { [reserveId]: { imageGeneration: { checkpointId: "chk_late_capture" } } },
        });
        expect(recorded.capture).toBeUndefined();
      } else {
        expect(recorded).toMatchObject({
          checkpointId: CHECKPOINT_ID,
          capture: { leaseId: reserveId, phase: "uncertain" },
        });
      }
      await noteDemand(provider, { leaseId: reserveId }, "e".repeat(64), expiresAtMs + 1, profile);
      expect((await warmImage())?.lastDemandAtMs).toBe(now);
      warn.mockClear();
      await expect(stop(provider, { leaseId: reserveId }, profile)).resolves.toBeUndefined();
      if (outcome === "success") {
        expect(calls.some(({ argv }) => argv[2] === "delete" && argv[3] === CHECKPOINT_ID)).toBe(
          true,
        );
      } else {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(recorded.capture!.selector));
        expect((await warmImage())?.capture).toEqual(recorded.capture);
      }
      expect(
        calls.filter(({ argv }) => argv[1] === "stop" && argv.includes(reserveId)),
      ).toHaveLength(1);
      expect((await warmImage())?.allocations[reserveId]).toBeUndefined();
    },
  );

  it("offers ready capacity only for immutable Linux warm-image profiles", async () => {
    const { provider, calls } = createWarmProvider();
    expect(provider.resolvePreparedIdleTimeoutMs?.(PROFILE)).toBe(3_600_000);
    expect(provider.resolvePreparationTarget?.(PROFILE, "fast")).toMatchObject(readyTarget);
    const protectedProfile = {
      ...PROFILE,
      setupSecrets: {
        SETUP_TOKEN: { source: "store", provider: "default", id: "PROTECTED_SETUP" },
      },
    };
    expect(provider.resolvePreparedIdleTimeoutMs?.(protectedProfile)).toBe(3_600_000);
    expect(provider.resolvePreparationTarget?.(protectedProfile, "fast")).toMatchObject(
      readyTarget,
    );
    for (const profile of [
      { ...PROFILE, warmImage: false },
      { ...CLASSLESS_PROFILE, target: "windows/wsl2" },
    ]) {
      expect(provider.resolvePreparedIdleTimeoutMs?.(profile)).toBeUndefined();
    }
    const { options } = projectOptions([], undefined, createPreparation("reserve"));
    await expect(
      provider.provision({ ...PROFILE, warmImage: false }, "disabled", options),
    ).rejects.toThrow("prepared workers require warm images");
    expect(calls).toEqual([]);
  });

  it("fully prepares a cold reserve after cache identity changes without claiming a replacement image", async () => {
    const events: string[] = [];
    const preparation = createPreparation("reserve");
    const profile = { ...PROFILE, setup: "synthetic-profile-setup" };
    let current = projectOptions(events, undefined, preparation);
    const { provider, calls } = createWarmProvider((call) => current.observe(call));
    await provider.provision(profile, "original-cache", current.options);
    const original = (await warmImage())!;
    events.length = 0;
    calls.length = 0;
    current = projectOptions(events, undefined, {
      ...preparation,
      key: "e".repeat(64),
      cacheKey: "f".repeat(64),
    });
    current.options.project.prepare.mockImplementationOnce(async (transport) => {
      await transport.runScript("changed-recipe-setup", current.options.project.signal);
      events.push("project-prepared");
      return preparedCapture;
    });
    const reserve = await provider.provision(profile, "changed-cache", current.options);
    expect(current.options.project.prepare).toHaveBeenCalledOnce();
    expect(calls.filter(({ options }) => options.input === profile.setup)).toHaveLength(1);
    expect(calls.filter(({ options }) => options.input === "changed-recipe-setup")).toHaveLength(1);
    expect(events).toEqual(["project-prepared", "enrollment-begun", "enrollment-install"]);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.some(({ argv }) => argv[2] === "fork" || argv[2] === "create")).toBe(false);
    expect(await warmImage()).toMatchObject({
      checkpointId: original.checkpointId,
      preparationKey: original.preparationKey,
      allocations: {
        [reserve.leaseId]: { phase: "enrolled", choice: { kind: "cold" }, imageGeneration: null },
      },
    });
    await noteDemand(provider, reserve, "e".repeat(64), preparation.demandAtMs + 60_000, profile);
    expect((await warmImage())?.lastDemandAtMs).toBe(original.lastDemandAtMs);
  });
});
