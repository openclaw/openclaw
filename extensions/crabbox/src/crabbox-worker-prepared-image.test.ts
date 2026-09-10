import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  BASE_COMMIT,
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  PROFILE,
  PROJECT_KEY,
  checkpointResult,
  commandResult,
  createProjectOptions as projectOptions,
  createWarmProvider,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox prepared image demand and custody", () => {
  it("keeps an older borrower's demand off a replacement generation", async () => {
    const now = Date.now();
    const preparation = {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "reserve" as const,
      demandAtMs: now,
    };
    let captures = 0;
    const { provider, calls } = createWarmProvider(({ argv }) =>
      argv[2] === "create"
        ? checkpointResult(`chk_demand_${++captures}`, argv[argv.indexOf("--id") + 1]!, "available")
        : undefined,
    );
    const seed = await provider.provision(
      PROFILE,
      "generation-seed",
      projectOptions([], new AbortController(), preparation).options,
    );
    const borrower = await provider.provision(
      PROFILE,
      "generation-borrower",
      projectOptions([], new AbortController(), { ...preparation, purpose: "session" }).options,
    );
    const next = projectOptions([], new AbortController(), preparation);
    next.options.project.prepare.mockResolvedValueOnce({
      seedKey: PROJECT_KEY,
      cacheHit: false,
      captureRequired: true,
    });
    const replacement = await provider.provision(PROFILE, "generation-replacement", next.options);
    expect(captures).toBe(2);
    await provider.notePreparedDemand!(
      { leaseId: borrower.leaseId, profile: PROFILE },
      { preparationKey: preparation.key, demandAtMs: now + 60_000 },
    );
    expect(listCrabboxWarmImages()[0]).toMatchObject({
      checkpointId: "chk_demand_2",
      lastDemandAtMs: now,
    });
    await provider.notePreparedDemand!(
      { leaseId: replacement.leaseId, profile: PROFILE },
      { preparationKey: preparation.key, demandAtMs: now + 60_000 },
    );
    expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(now + 60_000);
    await provider.destroy({ leaseId: borrower.leaseId, profile: PROFILE });
    await provider.destroy({ leaseId: replacement.leaseId, profile: PROFILE });
    expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    await provider.destroy({ leaseId: seed.leaseId, profile: PROFILE });
    expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual([
      "chk_demand_1",
    ]);
  });

  it.each(["session", "reserve"] as const)(
    "refreshes changed project setup once for %s and reuses the completed image",
    async (purpose) => {
      const events: string[] = [];
      const now = Date.now();
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "session" as const,
        demandAtMs: now,
      };
      const profile = { ...PROFILE, setup: "synthetic-profile-setup" };
      let current = projectOptions(events, new AbortController(), preparation);
      let captures = 0;
      const { provider, calls } = createWarmProvider((call) => {
        current.observe(call);
        return call.argv[2] === "create"
          ? checkpointResult(
              ++captures === 1 ? CHECKPOINT_ID : "chk_commit_b",
              call.argv[call.argv.indexOf("--id") + 1]!,
              "available",
            )
          : undefined;
      });
      current.options.project.baseCommit = "a".repeat(40);
      const source = await provider.provision(profile, "prepared-source", current.options);
      await provider.notePreparedDemand!(
        { leaseId: source.leaseId, profile },
        { preparationKey: preparation.key, demandAtMs: now },
      );
      await provider.destroy({ leaseId: source.leaseId, profile });
      const next = { ...preparation, key: "e".repeat(64), purpose };
      current = projectOptions(events, new AbortController(), next);
      calls.length = 0;
      const changed = await provider.provision(profile, "prepared-changed", current.options);
      expect(captures).toBe(2);
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        checkpointId: "chk_commit_b",
        baseCommit: BASE_COMMIT,
        preparationKey: next.key,
        purpose,
        lastDemandAtMs: purpose === "session" ? null : now,
      });
      expect(current.options.project.prepare).toHaveBeenCalledOnce();
      expect(calls.some(({ options }) => options.input === profile.setup)).toBe(false);
      await provider.notePreparedDemand!(
        { leaseId: changed.leaseId, profile },
        { preparationKey: next.key, demandAtMs: now + 60_000 },
      );
      await provider.destroy({ leaseId: changed.leaseId, profile });
      current = projectOptions(events, new AbortController(), { ...next, purpose: "session" });
      current.options.project.prepare.mockResolvedValueOnce({
        seedKey: PROJECT_KEY,
        cacheHit: true,
      });
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
      expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(now + 60_000);
    },
  );

  it.each(["cold", "warm"] as const)(
    "does not record session demand when %s enrollment fails",
    async (kind) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "session" as const,
        demandAtMs: now,
      };
      const { provider, calls } = createWarmProvider();
      if (kind === "warm") {
        const seed = projectOptions([], new AbortController(), {
          ...preparation,
          purpose: "reserve",
        });
        const lease = await provider.provision(PROFILE, "demand-seed", seed.options);
        await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
        clock.mockReturnValue(now + 60_000);
      }
      const current = projectOptions([], new AbortController(), {
        ...preparation,
        demandAtMs: Date.now(),
      });
      let demandBeforeRejection: number | null | undefined;
      current.options.beginNodeEnrollment.mockImplementationOnce(async () => {
        demandBeforeRejection = listCrabboxWarmImages()[0]?.lastDemandAtMs;
        throw new Error("enrollment admission failed");
      });
      calls.length = 0;
      await expect(provider.provision(PROFILE, "failed-demand", current.options)).rejects.toThrow(
        "enrollment admission failed",
      );
      expect(demandBeforeRejection).toBe(kind === "cold" ? null : now);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
      if (kind === "cold") {
        expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual(
          [CHECKPOINT_ID],
        );
        expect(listCrabboxWarmImages()).toEqual([]);
      } else {
        expect(listCrabboxWarmImages()[0]).toMatchObject({ lastDemandAtMs: now, allocations: {} });
        expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
      }
    },
  );

  it.each(["activation", "stop failure", "deletion failure"] as const)(
    "keeps an unactivated producer protected through %s",
    async (outcome) => {
      const now = Date.now();
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "session" as const,
        demandAtMs: now,
      };
      let failing = outcome !== "activation";
      const { provider, calls } = createWarmProvider(({ argv }) => {
        if (
          failing &&
          ((outcome === "stop failure" && argv[1] === "stop") ||
            (outcome === "deletion failure" && argv[2] === "delete"))
        ) {
          return commandResult({ code: 7, stderr: "cleanup unavailable" });
        }
        return undefined;
      });
      const current = projectOptions([], new AbortController(), preparation);
      const leaseId = operationLeaseId("unactivated-producer");
      if (outcome !== "activation") {
        current.options.beginNodeEnrollment.mockRejectedValueOnce(
          new Error("enrollment admission failed"),
        );
        await expect(
          provider.provision(PROFILE, "unactivated-producer", current.options),
        ).rejects.toThrow();
      } else {
        await provider.provision(PROFILE, "unactivated-producer", current.options);
      }
      const image = listCrabboxWarmImages()[0]!;
      expect(image.lastDemandAtMs).toBeNull();
      if (outcome === "deletion failure") {
        expect(image).toMatchObject({
          allocations: {},
          retirement: { checkpointId: CHECKPOINT_ID },
        });
      } else {
        expect(image.allocations[leaseId]?.imageGeneration?.checkpointId).toBe(CHECKPOINT_ID);
        calls.length = 0;
        await provider.maintain!({
          profiles: [PROFILE],
          signal: new AbortController().signal,
          assertCurrent() {},
        });
        expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
      }
      failing = false;
      if (outcome === "activation") {
        await provider.notePreparedDemand!(
          { leaseId, profile: PROFILE },
          { preparationKey: preparation.key, demandAtMs: now + 1 },
        );
        await provider.destroy({ leaseId, profile: PROFILE });
        expect(listCrabboxWarmImages()[0]).toMatchObject({
          lastDemandAtMs: now + 1,
          allocations: {},
        });
      } else {
        if (outcome === "stop failure") {
          await provider.destroy({ leaseId, profile: PROFILE });
        } else {
          await provider.maintain!({
            profiles: [PROFILE],
            signal: new AbortController().signal,
            assertCurrent() {},
          });
        }
        expect(listCrabboxWarmImages()).toEqual([]);
      }
    },
  );

  it.each([55_000, 60_000])(
    "shares the release deadline after predecessor deletion consumes %s ms",
    async (elapsed) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "reserve" as const,
        demandAtMs: now,
      };
      let captures = 0;
      const { provider, calls } = createWarmProvider(({ argv }) => {
        if (argv[2] === "create") {
          return checkpointResult(
            ++captures === 1 ? CHECKPOINT_ID : "chk_unactivated",
            argv[argv.indexOf("--id") + 1]!,
            "available",
          );
        }
        if (argv[2] === "delete" && argv[3] === CHECKPOINT_ID) {
          clock.mockReturnValue(now + elapsed);
        }
        return undefined;
      });
      const source = await provider.provision(
        PROFILE,
        "release-budget-source",
        projectOptions([], new AbortController(), preparation).options,
      );
      await provider.destroy({ leaseId: source.leaseId, profile: PROFILE });
      const current = projectOptions([], new AbortController(), {
        ...preparation,
        key: "e".repeat(64),
        purpose: "session",
      });
      current.options.beginNodeEnrollment.mockRejectedValueOnce(
        new Error("enrollment admission failed"),
      );
      await expect(
        provider.provision(PROFILE, "release-budget-session", current.options),
      ).rejects.toThrow("enrollment admission failed");
      const deletions = calls.filter(({ argv }) => argv[2] === "delete");
      expect(deletions[0]?.argv[3]).toBe(CHECKPOINT_ID);
      expect(deletions[0]?.options.timeoutMs).toBe(60_000);
      if (elapsed < 60_000) {
        expect(deletions[1]?.argv[3]).toBe("chk_unactivated");
        expect(deletions[1]?.options.timeoutMs).toBe(60_000 - elapsed);
        expect(listCrabboxWarmImages()).toEqual([]);
      } else {
        expect(deletions).toHaveLength(1);
        expect(listCrabboxWarmImages()[0]).toMatchObject({
          allocations: {},
          lastDemandAtMs: null,
          retirement: { checkpointId: "chk_unactivated" },
        });
        await provider.maintain!({
          profiles: [PROFILE],
          signal: new AbortController().signal,
          assertCurrent() {},
        });
        expect(listCrabboxWarmImages()).toEqual([]);
      }
    },
  );

  it.each(["success", "ambiguous"] as const)(
    "retains %s capture custody across reserve expiry without late enrollment or demand",
    async (outcome) => {
      const events: string[] = [];
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const expiresAtMs = now + 60_000;
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "session" as const,
        demandAtMs: now,
      };
      const profile = { ...PROFILE, idleTimeout: "1m" };
      let current = projectOptions(events, new AbortController(), preparation);
      current.options.project.baseCommit = "a".repeat(40);
      const entered = createDeferred<void>();
      const settle = createDeferred<void>();
      const operationId = `capture-expiry-${outcome}`;
      const reserveId = operationLeaseId(operationId);
      let captureSignal: AbortSignal | undefined;
      const { provider, calls, warn } = createWarmProvider(async (call) => {
        current.observe(call);
        if (call.argv[2] !== "create" || !call.argv.includes(reserveId)) {
          return undefined;
        }
        captureSignal = call.options.signal;
        entered.resolve();
        await settle.promise;
        return outcome === "success"
          ? checkpointResult("chk_late_capture", reserveId, "available")
          : commandResult({ code: 7, stderr: "capture response lost" });
      });
      const source = await provider.provision(profile, "capture-expiry-source", current.options);
      await provider.notePreparedDemand!(
        { leaseId: source.leaseId, profile },
        { preparationKey: preparation.key, demandAtMs: now },
      );
      await provider.destroy({ leaseId: source.leaseId, profile });
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
        await entered.promise;
        clock.mockReturnValue(expiresAtMs + 1);
        expect(captureSignal?.aborted).toBe(false);
        expect(listCrabboxWarmImages()[0]).toMatchObject({
          capture: { leaseId: reserveId, phase: "creating" },
          allocations: { [reserveId]: { phase: "prepared" } },
        });
        expect(current.options.beginNodeEnrollment).not.toHaveBeenCalled();
        expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
      } finally {
        settle.resolve();
        await provision;
      }
      await expect(provision).resolves.toMatchObject({
        error: { name: "AbortError", message: "Prepared worker expired" },
      });
      expect(current.options.beginNodeEnrollment).not.toHaveBeenCalled();
      const recorded = listCrabboxWarmImages()[0]!;
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
      await provider.notePreparedDemand!(
        { leaseId: reserveId, profile },
        { preparationKey: "e".repeat(64), demandAtMs: expiresAtMs + 1 },
      );
      expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(now);
      warn.mockClear();
      await expect(provider.destroy({ leaseId: reserveId, profile })).resolves.toBeUndefined();
      if (outcome === "success") {
        expect(calls.some(({ argv }) => argv[2] === "delete" && argv[3] === CHECKPOINT_ID)).toBe(
          true,
        );
      } else {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(recorded.capture!.selector));
        expect(listCrabboxWarmImages()[0]?.capture).toEqual(recorded.capture);
      }
      expect(
        calls.filter(({ argv }) => argv[1] === "stop" && argv.includes(reserveId)),
      ).toHaveLength(1);
      expect(listCrabboxWarmImages()[0]?.allocations[reserveId]).toBeUndefined();
    },
  );

  it("offers ready capacity only for immutable Linux warm-image profiles", async () => {
    const { provider, calls } = createWarmProvider();
    expect(provider.resolvePreparedIdleTimeoutMs?.(PROFILE)).toBe(3_600_000);
    expect(provider.resolvePreparationTarget?.(PROFILE, "fast")).toEqual({
      machineClass: "fast",
      platform: "linux",
    });
    for (const profile of [
      { ...PROFILE, warmImage: false },
      { ...PROFILE, setup: "setup", setupEnv: ["MUTABLE_INPUT"] },
      { ...CLASSLESS_PROFILE, target: "windows/wsl2" },
    ]) {
      expect(provider.resolvePreparedIdleTimeoutMs?.(profile)).toBeUndefined();
    }
    const { options } = projectOptions([], new AbortController(), {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "reserve",
      demandAtMs: Date.now(),
    });
    await expect(
      provider.provision({ ...PROFILE, warmImage: false }, "disabled", options),
    ).rejects.toThrow("prepared workers require warm images");
    expect(calls).toEqual([]);
  });

  it("fully prepares a cold reserve after cache identity changes without claiming a replacement image", async () => {
    const events: string[] = [];
    const preparation = {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "reserve" as const,
      demandAtMs: Date.now(),
    };
    const profile = { ...PROFILE, setup: "synthetic-profile-setup" };
    let current = projectOptions(events, new AbortController(), preparation);
    const { provider, calls } = createWarmProvider((call) => current.observe(call));
    await provider.provision(profile, "original-cache", current.options);
    const original = listCrabboxWarmImages()[0]!;
    events.length = 0;
    calls.length = 0;
    current = projectOptions(events, new AbortController(), {
      ...preparation,
      key: "e".repeat(64),
      cacheKey: "f".repeat(64),
    });
    current.options.project.prepare.mockImplementationOnce(async (transport) => {
      await transport.runScript("changed-recipe-setup", current.options.project.signal);
      events.push("project-prepared");
      return { seedKey: PROJECT_KEY, cacheHit: false, captureRequired: true };
    });
    const reserve = await provider.provision(profile, "changed-cache", current.options);
    expect(current.options.project.prepare).toHaveBeenCalledOnce();
    expect(calls.filter(({ options }) => options.input === profile.setup)).toHaveLength(1);
    expect(calls.filter(({ options }) => options.input === "changed-recipe-setup")).toHaveLength(1);
    expect(events).toEqual(["project-prepared", "enrollment-begun", "enrollment-install"]);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.some(({ argv }) => argv[2] === "fork" || argv[2] === "create")).toBe(false);
    expect(listCrabboxWarmImages()[0]).toMatchObject({
      checkpointId: original.checkpointId,
      preparationKey: original.preparationKey,
      allocations: {
        [reserve.leaseId]: { phase: "enrolled", choice: { kind: "cold" }, imageGeneration: null },
      },
    });
    await provider.notePreparedDemand!(
      { leaseId: reserve.leaseId, profile },
      { preparationKey: "e".repeat(64), demandAtMs: preparation.demandAtMs + 60_000 },
    );
    expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(original.lastDemandAtMs);
  });
});
